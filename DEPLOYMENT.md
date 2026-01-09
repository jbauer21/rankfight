# Production Deployment Guide

This guide explains how to deploy your RankFight application at production scale using Gunicorn.

## Prerequisites

- Python 3.7 or higher
- pip package manager
- A production server (Linux/Unix recommended)

## Installation

1. **Clone the repository** (if not already done):
   ```bash
   git clone <your-repo-url>
   cd rankfight
   ```

2. **Create a virtual environment** (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

## Configuration

1. **Set up environment variables**:
   
   Create a `.env` file or set environment variables directly:
   
   ```bash
   # Generate a secure secret key
   python -c "import secrets; print(secrets.token_hex(32))"
   
   # Set the SECRET_KEY environment variable
   export SECRET_KEY="your-generated-secret-key-here"
   ```

   For production, **NEVER** use the default secret key. Always generate a strong random key.

## Running with Gunicorn

### Basic Command

```bash
gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:8000 wsgi:app
```

### Recommended Production Command

```bash
gunicorn --worker-class eventlet -w 1 \
  --bind 0.0.0.0:8000 \
  --access-logfile - \
  --error-logfile - \
  --log-level info \
  wsgi:app
```

### Command Explanation

- `--worker-class eventlet`: Uses eventlet workers (required for WebSocket support with Flask-SocketIO)
- `-w 1`: Number of worker processes (for WebSocket apps, use 1 worker or configure sticky sessions)
- `--bind 0.0.0.0:8000`: Listen on all interfaces on port 8000
- `--access-logfile -`: Send access logs to stdout
- `--error-logfile -`: Send error logs to stderr
- `--log-level info`: Set logging level

### Important Notes on Workers

⚠️ **WebSocket Applications**: When using WebSockets with Flask-SocketIO:
- Use **only 1 worker** (`-w 1`) OR
- Implement a message queue (Redis, RabbitMQ) for multi-worker setups
- Without proper configuration, multiple workers will cause WebSocket connection issues

## Production Deployment Options

### Option 1: Systemd Service (Linux)

Create a systemd service file at `/etc/systemd/system/rankfight.service`:

```ini
[Unit]
Description=RankFight Gunicorn Application
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/path/to/rankfight
Environment="SECRET_KEY=your-secret-key-here"
ExecStart=/path/to/rankfight/venv/bin/gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:8000 wsgi:app

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl start rankfight
sudo systemctl enable rankfight  # Auto-start on boot
sudo systemctl status rankfight  # Check status
```

### Option 2: Docker Deployment

Create a `Dockerfile`:

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV SECRET_KEY="change-me-in-production"

EXPOSE 8000

CMD ["gunicorn", "--worker-class", "eventlet", "-w", "1", "--bind", "0.0.0.0:8000", "wsgi:app"]
```

Build and run:
```bash
docker build -t rankfight .
docker run -d -p 8000:8000 -e SECRET_KEY="your-secret-key" rankfight
```

### Option 3: Behind Nginx (Recommended)

Use Nginx as a reverse proxy for better performance and SSL/TLS support.

Nginx configuration (`/etc/nginx/sites-available/rankfight`):

```nginx
upstream rankfight {
    server 127.0.0.1:8000;
}

server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://rankfight;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }

    location /static {
        alias /path/to/rankfight/static;
        expires 30d;
    }
}
```

Enable and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/rankfight /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## Scaling Considerations

### Single Worker Limitations

With a single worker, your application can handle:
- Hundreds to thousands of concurrent WebSocket connections
- Limited by server CPU and memory

### Multi-Worker Setup (Advanced)

To scale beyond a single worker, you need to implement a message queue:

1. **Install Redis**:
   ```bash
   pip install redis
   ```

2. **Update `requirements.txt`**:
   ```
   redis==5.0.1
   ```

3. **Modify `app.py`**:
   ```python
   socketio = SocketIO(app, 
                       max_http_buffer_size=1e8,
                       cors_allowed_origins="*",
                       async_mode='eventlet',
                       message_queue='redis://localhost:6379/')
   ```

4. **Run with multiple workers**:
   ```bash
   gunicorn --worker-class eventlet -w 4 --bind 0.0.0.0:8000 wsgi:app
   ```

## Monitoring and Logs

### View logs:
```bash
# Systemd service logs
sudo journalctl -u rankfight -f

# Or if running directly
gunicorn --access-logfile access.log --error-logfile error.log ...
```

### Health checks:
Create a simple health endpoint in `app.py`:
```python
@app.route('/health')
def health():
    return {'status': 'healthy'}, 200
```

## Security Checklist

- ✅ Set a strong `SECRET_KEY` (never use the default)
- ✅ Use HTTPS in production (via Nginx with Let's Encrypt)
- ✅ Configure CORS properly (update `cors_allowed_origins` in production)
- ✅ Set appropriate file upload limits (already configured: 16MB)
- ✅ Keep dependencies updated: `pip install --upgrade -r requirements.txt`
- ✅ Use a firewall to restrict access to internal ports
- ✅ Run the application with a non-root user

## Troubleshooting

### WebSocket connection fails
- Ensure you're using `eventlet` worker class
- Check that Nginx is configured for WebSocket upgrade
- Verify CORS settings

### Application crashes
- Check logs: `sudo journalctl -u rankfight -f`
- Verify all environment variables are set
- Ensure sufficient memory and CPU resources

### Port already in use
```bash
# Find process using port 8000
sudo lsof -i :8000
# Kill the process if needed
kill -9 <PID>
```

## Testing the Deployment

1. **Start the server**:
   ```bash
   gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:8000 wsgi:app
   ```

2. **Access the application**:
   Open your browser to `http://your-server-ip:8000`

3. **Test WebSocket functionality**:
   - Create a lobby
   - Join from another browser/device
   - Verify real-time updates work

## Development vs Production

### Development (keep using):
```bash
python app.py
```

### Production (use gunicorn):
```bash
gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:8000 wsgi:app
```

## Additional Resources

- [Gunicorn Documentation](https://docs.gunicorn.org/)
- [Flask-SocketIO Deployment](https://flask-socketio.readthedocs.io/en/latest/deployment.html)
- [Nginx WebSocket Proxy](https://nginx.org/en/docs/http/websocket.html)

---

**Questions or Issues?** Check the logs first, and ensure all dependencies are properly installed.
