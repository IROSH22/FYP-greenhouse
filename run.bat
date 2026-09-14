@echo off
echo Starting Local Web Server...
echo Open your preferred browser (Opera, Chrome, etc.) and type:
echo.
echo     http://localhost:8000
echo.
echo (Press CTRL+C to stop the server)
python -m http.server 8000
pause
