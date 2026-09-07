@echo off
call "%~1" -arch=x64 >nul
if errorlevel 1 exit /b %errorlevel%
cl /nologo /O2 /EHsc /std:c++17 /Itest-results\signalsmith-threshold-source tests\inspect-stretch-threshold.cpp /Fo"test-results\stretch-threshold-%~2.obj" /Fe"test-results\stretch-threshold-%~2.exe"
exit /b %errorlevel%
