#!/bin/bash
#
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                    🐧 LINUX RANDOMX MINER (XMRig)                            ║
# ║                         MoneroOcean Pool Miner                               ║
# ║                     Works on ANY Linux Distribution                          ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
# Supports: Ubuntu, Debian, Fedora, CentOS, Arch, Alpine, OpenSUSE, and more!
#
# Features:
# - CPU temperature monitoring (auto throttle if too hot)
# - Connection quality check before mining
# - Nice terminal UI with colors
# - Auto XMRig download and setup
# - Full power by default
# - Works on x86_64 and ARM64
#

# =============================================================================
# VERSION INFO
# =============================================================================
CLIENT_VERSION="3.0.0"
CLIENT_VERSION_DATE="2025-12-27"

# =============================================================================
# CONFIGURATION
# =============================================================================
POOL_URL="gulf.moneroocean.stream:10128"
WALLET="42C9fVZdev5ZW7k6NmNGECVEpy2sCkA8JMpA1i2zLxUwCociGC3VzAbJ5WoMUFp3qeSqpCuueTvKgXZh8cnkbj957aBZiAB"
WORKER_NAME="linux-miner"
ALGO="rx/0"

# Temperature thresholds (Celsius)
TEMP_THROTTLE=80
TEMP_STOP=90
TEMP_RESUME=70

# XMRig download URLs
XMRIG_VERSION="6.21.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XMRIG_DIR="$SCRIPT_DIR/xmrig"
XMRIG_BIN="$XMRIG_DIR/xmrig"

# =============================================================================
# COLORS
# =============================================================================
RED='\033[0;91m'
GREEN='\033[0;92m'
YELLOW='\033[0;93m'
BLUE='\033[0;94m'
CYAN='\033[0;96m'
WHITE='\033[0;97m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# =============================================================================
# UI HELPERS
# =============================================================================
print_banner() {
    clear
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${YELLOW}  ██╗  ██╗███╗   ███╗██████╗     ███╗   ███╗██╗███╗   ██╗███████╗██████╗      ${CYAN}║${NC}"
    echo -e "${CYAN}║${YELLOW}  ╚██╗██╔╝████╗ ████║██╔══██╗    ████╗ ████║██║████╗  ██║██╔════╝██╔══██╗     ${CYAN}║${NC}"
    echo -e "${CYAN}║${YELLOW}   ╚███╔╝ ██╔████╔██║██████╔╝    ██╔████╔██║██║██╔██╗ ██║█████╗  ██████╔╝     ${CYAN}║${NC}"
    echo -e "${CYAN}║${YELLOW}   ██╔██╗ ██║╚██╔╝██║██╔══██╗    ██║╚██╔╝██║██║██║╚██╗██║██╔══╝  ██╔══██╗     ${CYAN}║${NC}"
    echo -e "${CYAN}║${YELLOW}  ██╔╝ ██╗██║ ╚═╝ ██║██║  ██║    ██║ ╚═╝ ██║██║██║ ╚████║███████╗██║  ██║     ${CYAN}║${NC}"
    echo -e "${CYAN}║${YELLOW}  ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝     ${CYAN}║${NC}"
    echo -e "${CYAN}╠══════════════════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║${WHITE}  RandomX Linux Miner v${CLIENT_VERSION} (Full Power Mode)                            ${CYAN}║${NC}"
    echo -e "${CYAN}║${GREEN}  Pool: MoneroOcean                                                            ${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

log_info() {
    echo -e "${WHITE}[$(date +%H:%M:%S)] ${BLUE}[i]${NC} $1"
}

log_success() {
    echo -e "${WHITE}[$(date +%H:%M:%S)] ${GREEN}[+]${NC} $1"
}

log_warning() {
    echo -e "${WHITE}[$(date +%H:%M:%S)] ${YELLOW}[!]${NC} $1"
}

log_error() {
    echo -e "${WHITE}[$(date +%H:%M:%S)] ${RED}[x]${NC} $1"
}

log_mining() {
    echo -e "${WHITE}[$(date +%H:%M:%S)] ${GREEN}[*]${NC} $1"
}

# =============================================================================
# DISTRO DETECTION
# =============================================================================
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        DISTRO_VERSION=$VERSION_ID
        DISTRO_NAME=$PRETTY_NAME
    elif [ -f /etc/lsb-release ]; then
        . /etc/lsb-release
        DISTRO=$DISTRIB_ID
        DISTRO_VERSION=$DISTRIB_RELEASE
        DISTRO_NAME=$DISTRIB_DESCRIPTION
    elif [ -f /etc/debian_version ]; then
        DISTRO="debian"
        DISTRO_VERSION=$(cat /etc/debian_version)
        DISTRO_NAME="Debian $DISTRO_VERSION"
    elif [ -f /etc/redhat-release ]; then
        DISTRO="rhel"
        DISTRO_NAME=$(cat /etc/redhat-release)
    else
        DISTRO="unknown"
        DISTRO_NAME="Unknown Linux"
    fi
    
    log_info "Detected: $DISTRO_NAME"
}

# =============================================================================
# ARCHITECTURE DETECTION
# =============================================================================
detect_arch() {
    ARCH=$(uname -m)
    case $ARCH in
        x86_64|amd64)
            ARCH_TYPE="x64"
            XMRIG_URL="https://github.com/xmrig/xmrig/releases/download/v${XMRIG_VERSION}/xmrig-${XMRIG_VERSION}-linux-x64.tar.gz"
            ;;
        aarch64|arm64)
            ARCH_TYPE="arm64"
            XMRIG_URL="https://github.com/xmrig/xmrig/releases/download/v${XMRIG_VERSION}/xmrig-${XMRIG_VERSION}-linux-static-x64.tar.gz"
            log_warning "ARM64 detected - using static build"
            ;;
        *)
            log_error "Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac
    log_info "Architecture: $ARCH_TYPE"
}

# =============================================================================
# CONNECTION CHECK
# =============================================================================
check_connection() {
    log_info "Checking connection quality..."
    
    # Check internet
    if ping -c 1 -W 5 8.8.8.8 &>/dev/null; then
        log_success "Internet: Connected"
    else
        log_error "Internet: No connection!"
        return 1
    fi
    
    # Check pool (extract host and port)
    POOL_HOST=$(echo $POOL_URL | cut -d: -f1)
    POOL_PORT=$(echo $POOL_URL | cut -d: -f2)
    
    if timeout 10 bash -c "cat < /dev/null > /dev/tcp/$POOL_HOST/$POOL_PORT" 2>/dev/null; then
        log_success "Pool ($POOL_HOST): Reachable"
    else
        # Try with nc if available
        if command -v nc &>/dev/null; then
            if nc -z -w10 $POOL_HOST $POOL_PORT 2>/dev/null; then
                log_success "Pool ($POOL_HOST): Reachable"
            else
                log_error "Pool: Unreachable"
                return 1
            fi
        else
            log_warning "Pool: Cannot verify (nc not installed)"
        fi
    fi
    
    # Latency test
    if command -v ping &>/dev/null; then
        LATENCY=$(ping -c 3 $POOL_HOST 2>/dev/null | tail -1 | awk '{print $4}' | cut -d '/' -f 2)
        if [ -n "$LATENCY" ]; then
            if (( $(echo "$LATENCY < 100" | bc -l 2>/dev/null || echo 0) )); then
                log_success "Latency: ${LATENCY}ms (Excellent)"
            elif (( $(echo "$LATENCY < 250" | bc -l 2>/dev/null || echo 0) )); then
                log_success "Latency: ${LATENCY}ms (Good)"
            else
                log_warning "Latency: ${LATENCY}ms (May cause stale shares)"
            fi
        fi
    fi
    
    log_success "Connection check passed!"
    return 0
}

# =============================================================================
# CPU TEMPERATURE
# =============================================================================
get_cpu_temp() {
    # Method 1: /sys/class/thermal (most common)
    if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
        TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
        if [ -n "$TEMP" ]; then
            echo $((TEMP / 1000))
            return 0
        fi
    fi
    
    # Method 2: sensors command
    if command -v sensors &>/dev/null; then
        TEMP=$(sensors 2>/dev/null | grep -oP 'Core 0.*?\+\K[0-9.]+' | head -1)
        if [ -n "$TEMP" ]; then
            echo "${TEMP%.*}"
            return 0
        fi
    fi
    
    # Method 3: /sys/devices/platform/coretemp
    for f in /sys/devices/platform/coretemp.*/hwmon/hwmon*/temp*_input; do
        if [ -f "$f" ]; then
            TEMP=$(cat "$f" 2>/dev/null)
            if [ -n "$TEMP" ]; then
                echo $((TEMP / 1000))
                return 0
            fi
        fi
    done
    
    # Method 4: ACPI
    if [ -f /proc/acpi/thermal_zone/THM0/temperature ]; then
        TEMP=$(cat /proc/acpi/thermal_zone/THM0/temperature 2>/dev/null | awk '{print $2}')
        if [ -n "$TEMP" ]; then
            echo "$TEMP"
            return 0
        fi
    fi
    
    echo ""
    return 1
}

# =============================================================================
# XMRIG INSTALLATION
# =============================================================================
install_xmrig() {
    log_info "XMRig not found. Downloading..."
    
    # Create directory
    mkdir -p "$XMRIG_DIR"
    
    # Download
    TARBALL="$SCRIPT_DIR/xmrig.tar.gz"
    log_info "Downloading from GitHub..."
    
    if command -v wget &>/dev/null; then
        wget -q --show-progress -O "$TARBALL" "$XMRIG_URL"
    elif command -v curl &>/dev/null; then
        curl -L -o "$TARBALL" "$XMRIG_URL"
    else
        log_error "Neither wget nor curl found. Please install one."
        exit 1
    fi
    
    if [ ! -f "$TARBALL" ]; then
        log_error "Download failed!"
        exit 1
    fi
    
    log_success "Download complete!"
    
    # Extract
    log_info "Extracting..."
    tar -xzf "$TARBALL" -C "$SCRIPT_DIR"
    
    # Find extracted folder and move contents
    EXTRACTED=$(find "$SCRIPT_DIR" -maxdepth 1 -type d -name "xmrig-*" | head -1)
    if [ -d "$EXTRACTED" ]; then
        rm -rf "$XMRIG_DIR"
        mv "$EXTRACTED" "$XMRIG_DIR"
    fi
    
    # Cleanup
    rm -f "$TARBALL"
    
    # Make executable
    chmod +x "$XMRIG_BIN"
    
    if [ -f "$XMRIG_BIN" ]; then
        log_success "XMRig installed successfully!"
        return 0
    else
        log_error "Installation failed!"
        return 1
    fi
}

check_xmrig() {
    if [ -f "$XMRIG_BIN" ] && [ -x "$XMRIG_BIN" ]; then
        return 0
    fi
    install_xmrig
    return $?
}

# =============================================================================
# TEMPERATURE MONITOR (Background)
# =============================================================================
MINER_PID=""
TEMP_PAUSED=0

temp_monitor() {
    while true; do
        TEMP=$(get_cpu_temp)
        if [ -n "$TEMP" ] && [ "$TEMP" -gt 0 ]; then
            if [ "$TEMP" -ge "$TEMP_STOP" ] && [ "$TEMP_PAUSED" -eq 0 ]; then
                log_error "CPU TEMP CRITICAL: ${TEMP}°C - STOPPING MINER!"
                if [ -n "$MINER_PID" ] && kill -0 "$MINER_PID" 2>/dev/null; then
                    kill "$MINER_PID" 2>/dev/null
                fi
                TEMP_PAUSED=1
            elif [ "$TEMP" -le "$TEMP_RESUME" ] && [ "$TEMP_PAUSED" -eq 1 ]; then
                log_success "CPU TEMP OK: ${TEMP}°C - Resuming..."
                TEMP_PAUSED=0
                start_xmrig &
            elif [ "$TEMP" -ge "$TEMP_THROTTLE" ]; then
                log_warning "CPU TEMP HIGH: ${TEMP}°C"
            fi
        fi
        sleep 10
    done
}

# =============================================================================
# MINING
# =============================================================================
start_xmrig() {
    log_mining "Starting XMRig at FULL POWER..."
    log_info "Using all $(nproc) CPU cores"
    
    "$XMRIG_BIN" \
        -o "$POOL_URL" \
        -u "$WALLET" \
        -p "$WORKER_NAME" \
        -a "$ALGO" \
        -k \
        --donate-level=1 \
        --print-time=5 \
        2>&1 | while IFS= read -r line; do
            # Colorize output
            if [[ "$line" == *"accepted"* ]]; then
                echo -e "${GREEN}${line}${NC}"
            elif [[ "$line" == *"rejected"* ]]; then
                echo -e "${RED}${line}${NC}"
            elif [[ "$line" == *"speed"* ]] || [[ "$line" == *"H/s"* ]]; then
                echo -e "${CYAN}${line}${NC}"
            elif [[ "$line" == *"error"* ]]; then
                echo -e "${RED}${line}${NC}"
            elif [[ "$line" == *"new job"* ]]; then
                echo -e "${YELLOW}${line}${NC}"
            elif [[ "$line" == *"BLOCK"* ]] || [[ "$line" == *"block"* ]]; then
                echo -e "${GREEN}${BOLD}*** ${line} ***${NC}"
            else
                echo "$line"
            fi
        done
    
    MINER_PID=$!
}

# =============================================================================
# CLEANUP
# =============================================================================
cleanup() {
    echo ""
    log_warning "Shutting down..."
    
    # Kill background jobs
    jobs -p | xargs -r kill 2>/dev/null
    
    if [ -n "$MINER_PID" ]; then
        kill "$MINER_PID" 2>/dev/null
    fi
    
    log_info "Miner stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM

# =============================================================================
# MAIN
# =============================================================================
main() {
    print_banner
    
    log_info "Version: $CLIENT_VERSION ($CLIENT_VERSION_DATE)"
    detect_distro
    detect_arch
    log_info "CPU Cores: $(nproc)"
    echo ""
    
    # Connection check
    if ! check_connection; then
        log_error "Connection check failed!"
        log_error "Please check your internet connection and try again."
        exit 1
    fi
    
    echo ""
    log_info "Wallet: ${WALLET:0:12}...${WALLET: -8}"
    log_info "Pool: $POOL_URL"
    log_info "Algorithm: $ALGO (RandomX)"
    log_mining "Mode: FULL POWER (all cores)"
    echo ""
    
    # Temperature check
    TEMP=$(get_cpu_temp)
    if [ -n "$TEMP" ] && [ "$TEMP" -gt 0 ]; then
        log_info "CPU Temperature: ${TEMP}°C"
    else
        log_warning "CPU Temperature: Not available (install lm-sensors)"
    fi
    
    echo ""
    echo -e "${YELLOW}$(printf '=%.0s' {1..78})${NC}"
    echo -e "${YELLOW}  Press Ctrl+C to stop mining${NC}"
    echo -e "${YELLOW}$(printf '=%.0s' {1..78})${NC}"
    echo ""
    
    # Check/Install XMRig
    if ! check_xmrig; then
        log_error "Failed to install XMRig"
        exit 1
    fi
    
    # Start temperature monitor in background
    temp_monitor &
    
    # Start mining
    start_xmrig
}

# Run
main "$@"
