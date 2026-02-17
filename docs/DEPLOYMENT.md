# 🐍 Ouroboros Mission Control - Deployment Guide

## Overview

The Ouroboros Web UI consists of two main components:
1. **Web UI** (React 19 + Vite) - The Mission Control dashboard
2. **Daemon** (Fastify) - The backend with WebSocket, SSE, and PTY support

## Deployment Options

### Option 1: Development Mode (Separate Processes)

Best for development and debugging.

```bash
# Terminal 1: Start the daemon
bun run daemon

# Terminal 2: Start the web UI dev server
cd web
bun run dev

# Access at http://localhost:3000
# Daemon API at http://localhost:7777
```

### Option 2: Production Mode (Integrated)

Best for production deployment.

```bash
# Build the web UI
bun run web:build

# Start the enhanced daemon with static file serving
bun run daemon:enhanced

# Access at http://localhost:7777
```

### Option 3: Docker Deployment

```dockerfile
# Dockerfile
FROM oven/bun:1 as builder

WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install

COPY . .
RUN bun run web:build

FROM oven/bun:1

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/cli/src/daemon ./daemon

EXPOSE 7777

CMD ["bun", "run", "daemon:enhanced"]
```

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Daemon Configuration
DAEMON_PORT=7777
DAEMON_HOST=0.0.0.0
API_KEY=your-api-key-here

# Web UI Configuration (development only)
VITE_DAEMON_URL=ws://localhost:7777

# CORS Origins (comma-separated)
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

### Daemon Configuration

The enhanced daemon supports the following options:

```typescript
const server = new EnhancedDaemonServer(storage, {
  port: 7777,
  host: '0.0.0.0',
  corsOrigin: ['http://localhost:3000'],
  staticDir: './web/dist',  // Enable static file serving
  enableWebUI: true,
});
```

## API Endpoints

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/status` | GET | Daemon status |
| `/api/rpc` | POST | JSON-RPC 2.0 |

### WebSocket Endpoints

| Endpoint | Description |
|----------|-------------|
| `/ws` | EventBus streaming |
| `/pty/:sessionId` | Terminal PTY |

### SSE Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/stream/:sessionId` | Agent response streaming |

## Security Considerations

1. **API Key**: Set a strong `API_KEY` environment variable
2. **CORS**: Restrict `CORS_ORIGINS` to your domain(s)
3. **Host**: Use `127.0.0.1` for local-only access, `0.0.0.0` for network access
4. **Firewall**: Only expose port 7777 if needed

## Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name ouroboros.local;

    location / {
        proxy_pass http://localhost:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## SSL/TLS (Let's Encrypt)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d ouroboros.yourdomain.com
```

## Monitoring

### Health Check

```bash
curl http://localhost:7777/health
```

### Logs

```bash
# View daemon logs
journalctl -u ouroboros -f

# View web UI logs (if using PM2)
pm2 logs ouroboros-web
```

## Troubleshooting

### WebSocket Connection Failed

1. Check daemon is running: `curl http://localhost:7777/health`
2. Verify CORS origins match your web UI URL
3. Check firewall rules

### Build Errors

```bash
# Clean and rebuild
rm -rf web/dist
rm -rf web/node_modules
bun install
bun run web:build
```

### Port Already in Use

```bash
# Find process using port 7777
lsof -i :7777

# Kill process
kill -9 <PID>
```

## Systemd Service

Create `/etc/systemd/system/ouroboros.service`:

```ini
[Unit]
Description=Ouroboros Daemon
After=network.target

[Service]
Type=simple
User=ouroboros
WorkingDirectory=/opt/ouroboros
ExecStart=/usr/local/bin/bun run daemon:enhanced
Restart=always
Environment=DAEMON_PORT=7777
Environment=API_KEY=your-api-key

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable ouroboros
sudo systemctl start ouroboros
```
