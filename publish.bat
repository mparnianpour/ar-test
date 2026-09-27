@echo off
setlocal
title Publish ketabkhoneh to GitHub
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\Git\cmd"
set "REPO_URL=https://github.com/mparnianpour/ar-test.git"

rem --- Safety: only ever run inside the ketabkhoneh project ---
if not exist "package.json" goto wrongfolder
if not exist "src\.expanse.json" goto wrongfolder
where git >nul 2>&1
if errorlevel 1 goto nogit

rem --- Step 1: the home folder was turned into a git copy of ar-test by mistake ---
set "HOMEURL="
set "HOMECOUNT="
if exist "%USERPROFILE%\.git\" (
  for /f "delims=" %%u in ('git -C "%USERPROFILE%" remote get-url origin 2^>nul') do set "HOMEURL=%%u"
  for /f "delims=" %%c in ('git -C "%USERPROFILE%" rev-list --count HEAD 2^>nul') do set "HOMECOUNT=%%c"
)
if /i not "%HOMEURL%"=="%REPO_URL%" goto publish
if not "%HOMECOUNT%"=="1" goto publish

echo.
echo Your home folder %USERPROFILE% was set up as a git copy of ar-test by mistake.
echo That is why the earlier "git add ." grabbed your whole user folder.
echo Removing it deletes only the hidden .git folder there. Your files are not touched.
echo.
choice /c YN /t 15 /d Y /m "Remove it now - Y is chosen automatically in 15 seconds"
if errorlevel 2 goto publish
echo Removing %USERPROFILE%\.git ...
rmdir /s /q "%USERPROFILE%\.git"
if exist "%USERPROFILE%\.git\" echo Could not remove all of it. Close every Git Bash window and run this file again.
if exist "%USERPROFILE%\.git\" goto end
echo Removed.

rem --- Step 2: upload this project ---
:publish
echo.
echo Publishing this folder to %REPO_URL%
echo.

if exist "deploy.yml" (
  if not exist ".github\workflows\" mkdir ".github\workflows"
  move /y "deploy.yml" ".github\workflows\deploy.yml" >nul
)

if not exist ".git\" git init
if not exist ".git\" goto failed

git config user.email >nul 2>&1
if errorlevel 1 git config user.email "mparnianpour@users.noreply.github.com"
git config user.name >nul 2>&1
if errorlevel 1 git config user.name "Mahdi"

git add -A
if errorlevel 1 goto failed
git diff --cached --quiet
if errorlevel 1 git commit -q -m "ketabkhoneh 8th Wall project"
if errorlevel 1 goto failed
git branch -M main
if errorlevel 1 goto failed

git remote get-url origin >nul 2>&1
if errorlevel 1 (git remote add origin %REPO_URL%) else (git remote set-url origin %REPO_URL%)

echo.
echo Connecting to GitHub. If a sign-in window opens, sign in as mparnianpour.
git fetch origin
if errorlevel 1 goto failed
git rev-parse --verify --quiet origin/main >nul
if errorlevel 1 goto push
git merge --no-edit --allow-unrelated-histories origin/main
if errorlevel 1 goto failed

:push
git push -u origin main
if errorlevel 1 goto failed

echo.
echo ============================================================
echo  Uploaded. GitHub is building the site now - about 2 minutes.
echo  Your WebAR link:  https://mparnianpour.github.io/ar-test/
echo  Opening the build page so you can watch it finish...
echo ============================================================
start "" "https://github.com/mparnianpour/ar-test/actions"
goto end

:wrongfolder
echo This file must sit inside the ketabkhoneh project folder. Nothing was done.
goto end

:nogit
echo Git was not found on this computer. Nothing was done.
goto end

:failed
echo.
echo Something went wrong - see the message above.
echo Copy the text in this window and send it to Claude.

:end
echo.
pause
