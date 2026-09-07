import importlib.util
import json
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("manager_harness", ROOT / "tests/verify-violentmonkey.py")
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
URL = "http://127.0.0.1:4322/?browser-zoom-verification"
OUTPUT = ROOT / "test-results/browser-zoom.json"

METRICS = """() => ({
  innerWidth, innerHeight, outerWidth, outerHeight,
  devicePixelRatio, clientWidth: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
  bodyScrollWidth: document.body.scrollWidth,
  visualScale: visualViewport.scale,
  horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
})"""


def focus_record(page):
    return page.evaluate("""() => {
      const e = document.activeElement, r = e.getBoundingClientRect();
      return {tag:e.tagName,id:e.id,role:e.getAttribute('role'),
        name:e.getAttribute('aria-label') || e.textContent.trim().slice(0,80),
        rect:{x:r.x,y:r.y,width:r.width,height:r.height},
        visible:r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight};
    }""")


def tab_to(page, locator, limit=70):
    path = []
    for _ in range(limit):
        if locator.evaluate("e => e === document.activeElement"):
            assert focus_record(page)["visible"], "Keyboard focus is outside the viewport."
            return path
        page.keyboard.press("Tab")
        path.append(focus_record(page))
    raise AssertionError("Target not reachable by Tab: " + str(path))


def check_overflow(page, stage, result):
    metrics = page.evaluate(METRICS)
    result.setdefault("overflow_checks", {})[stage] = metrics
    assert not metrics["horizontalOverflow"], f"Horizontal page overflow during {stage}: {metrics}"


def exercise(page, result):
    trigger = page.locator(".select-trigger")
    result["tab_path_to_pitch"] = tab_to(page, trigger)
    trigger.press("ArrowDown")
    natural = page.get_by_role("option", name="Natural", exact=True)
    preserve = page.get_by_role("option", name="Preserve key", exact=True)
    expect(natural).to_be_focused()
    natural.press("ArrowDown")
    expect(preserve).to_be_focused()
    assert focus_record(page)["visible"]
    check_overflow(page, "pitch_menu_open", result)
    result["pitch_option_focus"] = focus_record(page)
    preserve.press("Enter")
    expect(trigger).to_be_focused()
    expect(trigger).to_contain_text("Pitch:")
    expect(trigger).to_contain_text("Preserve key")
    trigger.click()
    preserve.press("Escape")
    expect(trigger).to_be_focused()
    expect(trigger).to_have_attribute("aria-expanded", "false")

    point = page.locator("#demo-nodes .node").nth(2)
    result["tab_path_to_graph"] = tab_to(page, point)
    expect(point).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_label("Target speed", exact=True)).to_have_value("0.9")
    point.press("ArrowUp")
    expect(page.locator("#demo-point-rate")).to_have_value("0.925")
    point.press("Enter")
    expect(page.locator("#demo-point-rate")).to_be_focused()
    check_overflow(page, "graph_keyboard", result)
    result["graph_field_focus"] = focus_record(page)

    page.locator("#demo-nodes .node").nth(1).click()
    expect(page.locator("#demo-nodes .node").nth(1)).to_have_attribute("aria-pressed", "true")
    expect(point).to_have_attribute("aria-pressed", "false")
    expect(page.locator("#demo-point-rate")).to_have_value("0.75")
    page.locator("#demo-nodes .node").nth(2).click()
    point.press("Enter")
    summary = page.locator("summary").filter(has_text="Point timing")
    result["tab_path_to_timing"] = tab_to(page, summary)
    summary.press("Enter")
    expect(page.locator("#demo-point-time")).to_be_visible()
    time = page.locator("#demo-point-time")
    result["tab_path_to_time_input"] = tab_to(page, time)
    time.fill("19")
    time.press("Enter")
    expect(time).to_have_value("19")
    fade = page.locator("#demo-point-fade")
    result["tab_path_to_fade_input"] = tab_to(page, fade)
    fade.fill("7")
    fade.press("Enter")
    expect(fade).to_have_value("7")
    check_overflow(page, "timing_fields_open", result)
    result["timing_field_focus"] = focus_record(page)
    assert result["timing_field_focus"]["visible"]

    page.get_by_role("button", name="Fixed speed", exact=True).click()
    exact = page.locator("#demo-speed-number")
    exact.fill("1.25")
    exact.press("Enter")
    expect(exact).to_have_value("1.25")
    page.get_by_role("button", name="Timeline", exact=True).click()
    page.get_by_role("button", name="Reset demo", exact=True).click()
    expect(page.locator("#demo-point-rate")).to_have_value("0.9")
    expect(trigger).to_contain_text("Natural")
    check_overflow(page, "reset", result)
    assert page.locator(".timeline-demo").get_attribute("data-playback") == "idle"
    result["controls"] = "PASS: pitch keyboard/click/Escape, SVG Tab/click/arrow/Enter, timing fields, fixed/timeline/reset"


def main():
    manager.verify_assets()
    profile = Path(tempfile.mkdtemp(prefix="browser-zoom-profile-", dir=ROOT / "test-results"))
    result = {
        "profile": str(profile), "url": URL,
        "method": "chrome.tabs.setZoom via unmodified official Violentmonkey worker; no CSS/CDP zoom emulation",
        "browser": "Chrome for Testing 148.0.7778.96, Playwright Chromium 1223",
        "audio": "--mute-audio; no playback or music loading requested",
        "viewport": "no_viewport=True; --window-size=1440,1000",
        "levels": [], "status": "RUNNING",
    }
    context = None
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile), executable_path=str(manager.CHROMIUM), headless=True,
                no_viewport=True,
                args=[f"--disable-extensions-except={manager.EXTENSION}",
                      f"--load-extension={manager.EXTENSION}", "--mute-audio", "--window-size=1440,1000"],
            )
            context.set_default_timeout(10000)
            try:
                worker = manager.worker_for(context)
                result["user_scripts_permission"] = worker.evaluate("typeof chrome.userScripts")
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(URL)
                page.locator("#demo-nodes .node").nth(2).wait_for()
                tabs = worker.evaluate("() => chrome.tabs.query({})")
                tab_id = next(tab["id"] for tab in tabs if tab.get("url") == URL)
                result["tab_id"] = tab_id
                worker.evaluate("id => chrome.tabs.setZoomSettings(id, {mode:'automatic',scope:'per-tab'})", tab_id)
                worker.evaluate("id => chrome.tabs.setZoom(id, 1)", tab_id)
                baseline = page.evaluate(METRICS)
                result["baseline"] = baseline
                for factor in (2, 4):
                    page.goto(URL)
                    page.locator("#demo-nodes .node").nth(2).wait_for()
                    worker.evaluate("({id,factor}) => chrome.tabs.setZoom(id,factor)", {"id":tab_id,"factor":factor})
                    page.wait_for_function("expected => Math.abs(devicePixelRatio-expected)<0.02", arg=baseline["devicePixelRatio"] * factor)
                    metrics = page.evaluate(METRICS)
                    entry = {"factor": factor, "tabs_api_zoom": worker.evaluate("id => chrome.tabs.getZoom(id)", tab_id), "metrics": metrics}
                    result["levels"].append(entry)
                    assert abs(entry["tabs_api_zoom"] - factor) < 0.000001
                    assert metrics["outerWidth"] == baseline["outerWidth"]
                    assert metrics["outerHeight"] == baseline["outerHeight"]
                    assert abs(metrics["innerWidth"] * factor - baseline["innerWidth"]) <= factor
                    assert metrics["visualScale"] == 1, "Visual viewport emulation unexpectedly active."
                    check_overflow(page, "initial", entry)
                    try:
                        exercise(page, entry)
                        entry["status"] = "PASS"
                    except Exception:
                        entry["status"] = "FAIL"
                        page.screenshot(path=str(ROOT / f"test-results/browser-zoom-{factor}x-failure.png"))
                        raise
                result["page_errors"] = errors
                assert not errors, errors
                result["status"] = "PASS"
                worker.evaluate("id => chrome.tabs.setZoom(id,1)", tab_id)
            finally:
                context.close()
                result["context_closed"] = True
    except Exception as error:
        result["status"] = "FAIL"
        result["error"] = str(error)
        raise
    finally:
        OUTPUT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status":result["status"],"report":str(OUTPUT),"error":result.get("error")}, indent=2))


if __name__ == "__main__":
    main()
