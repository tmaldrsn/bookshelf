# Expose Bookshelf on your tailnet over HTTPS as its own hostname (a Tailscale Service).
# Prerequisites (one time, in the Tailscale admin console): tag this machine, define the service
# "svc:books" on port 443, and grant yourself access. See README.md.
#
#   Enable:   powershell -ExecutionPolicy Bypass -File scripts\tailscale-serve.ps1
#   Disable:  powershell -ExecutionPolicy Bypass -File scripts\tailscale-serve.ps1 -Off
param(
    [string]$Service = "svc:books",
    [int]$Port = 8765,
    [switch]$Off
)

if ($Off) {
    tailscale serve clear $Service
} else {
    tailscale serve --service=$Service --https=443 "http://localhost:$Port"
}
tailscale serve status
