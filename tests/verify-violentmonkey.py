import hashlib
import json
import tempfile
from pathlib import Path
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "test-results/manager-assets"
MANAGER_VERSION = "2.48.0"
MANAGER_URL = (
    "https://github.com/violentmonkey/violentmonkey/releases/download/"
    "v2.48.0/Violentmonkey-mv3-v2.48.0.zip"
)
MANAGER_SHA256 = "583ac595bb698a926eadb6064431fce1108dc2f2adb966ed984738824d2d5a54"
SCRIPT_SHA256 = "16441d20f57c7ebeb4b0f6bcf0d94cb85486604b3a7d5144b57abb7850a50ac5"
SCRIPT_NAME = "SoundCloud Tempo Control (Natural Pitch)"
BASE = "http://127.0.0.1:4322/"
FIXTURE_URL = "https://soundcloud.com/test-artist/first-track"
EXTENSION = ASSETS / "violentmonkey-2.48.0"
CHROMIUM = ASSETS / "playwright-browsers/chromium-1223/chrome-win64/chrome.exe"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_assets():
    archive = ASSETS / "Violentmonkey-mv3-v2.48.0.zip"
    if not archive.is_file() or not CHROMIUM.is_file():
        raise RuntimeError(
            "Missing isolated test assets. Download the pinned official manager "
            "archive and Playwright Chromium revision 1223 into manager-assets."
        )
    assert digest(archive.read_bytes()) == MANAGER_SHA256
    with ZipFile(archive) as package:
        for entry in package.infolist():
            if not entry.is_dir():
                assert (EXTENSION / entry.filename).read_bytes() == package.read(entry)
    script = (ROOT / "dist/soundcloud-tempo-control.user.js").read_bytes()
    assert digest(script) == SCRIPT_SHA256, "Build changed; repin deliberately."
    return script.decode("utf-8")


def launch(playwright, profile):
    context = playwright.chromium.launch_persistent_context(
        str(profile),
        executable_path=str(CHROMIUM),
        headless=True,
        args=[
            f"--disable-extensions-except={EXTENSION}",
            f"--load-extension={EXTENSION}",
            "--mute-audio",
        ],
    )
    context.set_default_timeout(10000)
    return context


def worker_for(context):
    return context.service_workers[0] if context.service_workers else context.wait_for_event(
        "serviceworker", timeout=15000
    )


def stored_script(worker, expected_source):
    storage = worker.evaluate("() => chrome.storage.local.get(null)")
    normalized = expected_source.replace("\r\n", "\n")
    code_keys = [
        key for key, value in storage.items()
        if isinstance(value, str) and value.replace("\r\n", "\n") == normalized
    ]
    assert code_keys, "Manager storage does not contain the unmodified userscript."
    metadata_keys = [
        key for key, value in storage.items()
        if isinstance(value, dict) and value.get("meta", {}).get("name") == SCRIPT_NAME
    ]
    assert metadata_keys, "Installed script metadata is absent."
    return {"code_keys": code_keys, "metadata_keys": metadata_keys}


def main():
    source = verify_assets()
    profile = Path(tempfile.mkdtemp(prefix="violentmonkey-profile-", dir=ROOT / "test-results"))
    result = {
        "profile": str(profile),
        "manager": {"version": MANAGER_VERSION, "source": MANAGER_URL, "sha256": MANAGER_SHA256},
        "userscript_sha256": SCRIPT_SHA256,
        "browser_source": "https://cdn.playwright.dev/builds/cft/148.0.7778.96/win64/chrome-win64.zip",
        "browser_revision": 1223,
        "audio": "--mute-audio; no playback requested",
    }
    output = ROOT / "test-results/violentmonkey-installation.json"
    with sync_playwright() as playwright:
        context = launch(playwright, profile)
        try:
            worker = worker_for(context)
            result["browser_user_agent"] = worker.evaluate("navigator.userAgent")
            result["apis"] = worker.evaluate(
                "() => ({userScripts:typeof chrome.userScripts,tabsSetZoom:typeof chrome.tabs.setZoom})"
            )
            extension_base = worker.url.rsplit("/", 1)[0]
            page = context.new_page()
            page.goto(BASE)
            page.get_by_role("link", name="Install userscript", exact=True).click()
            page.wait_for_url("chrome-extension://**/confirm/index.html**", timeout=15000)
            expect(page.get_by_text(SCRIPT_NAME + ", 1.0.0", exact=True)).to_be_visible()
            page.get_by_text("Install", exact=True).click()
            dashboard = context.new_page()
            dashboard.goto(extension_base + "/options/index.html")
            expect(dashboard.get_by_text(SCRIPT_NAME, exact=True)).to_be_visible(timeout=15000)
            result["installer"] = "Official manager confirmation UI completed"
            result["installed_storage"] = stored_script(worker, source)
            result["manager_warning"] = dashboard.locator("body").inner_text().split("\n")[0]
            dashboard.screenshot(path=str(ROOT / "test-results/violentmonkey-installed.png"))
        finally:
            context.close()

        context = launch(playwright, profile)
        try:
            worker = worker_for(context)
            result["storage_after_browser_restart"] = stored_script(worker, source)
            fixture = (ROOT / "tests/fixtures/inline-fixture.html").read_text(encoding="utf-8")
            context.route(FIXTURE_URL, lambda route: route.fulfill(status=200, content_type="text/html", body=fixture))
            page = context.new_page()
            page.goto(FIXTURE_URL)
            if result["apis"]["userScripts"] == "undefined":
                page.wait_for_timeout(1000)
                assert page.locator("#soundcloud-tempo-control").count() == 0
                result["injection"] = "BLOCKED: Chromium Allow User Scripts permission is disabled"
                result["settings_persistence"] = "Not tested because manager injection is blocked"
                status = 2
            else:
                expect(page.locator("#soundcloud-tempo-control")).to_be_visible(timeout=15000)
                result["injection"] = "Actual manager injected into a locally fulfilled SoundCloud-origin fixture"
                number = page.locator("#rate-number")
                number.fill("0.85")
                number.press("Enter")
                page.locator(".memory").click()
                expect(page.locator(".memory")).to_have_attribute("data-state", "saved")
                page.reload()
                expect(number).to_have_value("0.85")
                result["settings_persistence"] = "Saved 0.85x via the injected UI and restored on reload"
                status = 0
            result["fixture_url"] = FIXTURE_URL
            result["fixture_is_local"] = True
        finally:
            context.close()
        if status == 0:
            context = launch(playwright, profile)
            try:
                context.route(FIXTURE_URL, lambda route: route.fulfill(status=200, content_type="text/html", body=fixture))
                page = context.new_page()
                page.goto(FIXTURE_URL)
                expect(page.locator("#rate-number")).to_have_value("0.85", timeout=15000)
                expect(page.locator(".memory")).to_have_attribute("data-state", "saved")
                result["settings_after_browser_restart"] = "0.85x restored by the actual manager-injected userscript"
            finally:
                context.close()
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
