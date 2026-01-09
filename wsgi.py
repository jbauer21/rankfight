"""
WSGI entry point for production deployment with gunicorn.

This file is used to run the application with gunicorn using eventlet workers
for WebSocket support.

Usage:
    gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:8000 wsgi:app
"""

from app import app, socketio

if __name__ == "__main__":
    socketio.run(app)
