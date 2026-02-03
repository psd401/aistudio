# Docker Cleanup for Local Development

Docker can consume significant disk space over time through build cache, dangling images, and orphaned volumes. This guide explains how to manage Docker disk usage during local development.

## The Problem

Docker accumulates disk usage from:
- **Build cache**: Intermediate layers from `docker build` operations
- **Dangling images**: Old image layers no longer tagged
- **Orphaned volumes**: Data volumes from deleted containers

Symptoms of disk space issues:
```
PANIC: could not write to file "pg_logical/replorigin_checkpoint.tmp": No space left on device
FATAL: could not write lock file "postmaster.pid": No space left on device
```

## Quick Fix

If you're experiencing disk space issues right now:

```bash
# Stop containers
docker compose down

# Clean everything
docker builder prune -f
docker volume prune -f
docker image prune -f

# Restart
docker compose up -d
```

## Using the Cleanup Script

We provide a cleanup script at `scripts/docker-cleanup.sh`:

### Quick Cleanup (Safe While Running)

Cleans build cache and dangling images without stopping containers:

```bash
./scripts/docker-cleanup.sh
```

### Deep Cleanup (Stops Containers)

Stops containers, cleans volumes, then restarts:

```bash
./scripts/docker-cleanup.sh --deep
```

## Automated Weekly Cleanup (macOS)

To prevent disk space issues, set up automated weekly cleanup using macOS LaunchAgent:

### 1. Create the LaunchAgent

```bash
cat > ~/Library/LaunchAgents/com.aistudio.docker-cleanup.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aistudio.docker-cleanup</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/aistudio/scripts/docker-cleanup.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/docker-cleanup.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/docker-cleanup.error.log</string>
</dict>
</plist>
EOF
```

**Important**: Update `/path/to/aistudio/` to your actual repository path.

### 2. Load the LaunchAgent

```bash
launchctl load ~/Library/LaunchAgents/com.aistudio.docker-cleanup.plist
```

### 3. Manage the Schedule

```bash
# Check status
launchctl list | grep docker-cleanup

# Run manually (test)
launchctl start com.aistudio.docker-cleanup

# View logs
cat /tmp/docker-cleanup.log

# Disable
launchctl unload ~/Library/LaunchAgents/com.aistudio.docker-cleanup.plist

# Re-enable
launchctl load ~/Library/LaunchAgents/com.aistudio.docker-cleanup.plist
```

## Manual Cleanup Commands

### Check Current Usage

```bash
docker system df
```

Example output:
```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          16        3         14.07GB   6.788GB (48%)
Containers      3         2         43.3MB    0B (0%)
Local Volumes   24        4         24.01GB   20.58GB (85%)
Build Cache     140       0         21.62GB   12.29GB
```

### Individual Cleanup Commands

| Command | What it cleans | Safe while running? |
|---------|----------------|---------------------|
| `docker builder prune -f` | Build cache | Yes |
| `docker image prune -f` | Dangling images | Yes |
| `docker volume prune -f` | Unused volumes | No - stop containers first |
| `docker container prune -f` | Stopped containers | Yes |
| `docker system prune -f` | All of the above (except volumes) | Yes |
| `docker system prune -f --volumes` | Everything including volumes | No - stop containers first |

### Nuclear Option

If you need to completely reset Docker (loses all data):

```bash
# Stop everything
docker compose down

# Remove ALL Docker data
docker system prune -af --volumes

# Restart fresh
docker compose up -d
npm run db:seed  # Re-create test users
```

## Recommended Maintenance Schedule

| Frequency | Action | Command |
|-----------|--------|---------|
| Weekly | Quick cleanup | `./scripts/docker-cleanup.sh` |
| Monthly | Deep cleanup | `./scripts/docker-cleanup.sh --deep` |
| As needed | Check usage | `docker system df` |

## Troubleshooting

### PostgreSQL Won't Start After Disk Full

1. Free up space first:
   ```bash
   docker builder prune -f
   docker volume prune -f  # Only if postgres container is stopped
   ```

2. Then restart:
   ```bash
   npm run db:up
   ```

### LaunchAgent Not Running

Check if it's loaded:
```bash
launchctl list | grep docker-cleanup
```

If not listed, reload it:
```bash
launchctl load ~/Library/LaunchAgents/com.aistudio.docker-cleanup.plist
```

### Permission Denied on Script

Make sure the script is executable:
```bash
chmod +x scripts/docker-cleanup.sh
```
