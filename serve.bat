@echo off
cd /d "%~dp0"
echo Live Metronome  ->  http://localhost:8080
python -m http.server 8080 --bind 0.0.0.0
