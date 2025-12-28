#!/bin/bash
# =============================================================================
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                       XMR Native Miner for Linux                             ║
# ║                    Connects to Proxy Server (Combined Mining)                ║
# ╠══════════════════════════════════════════════════════════════════════════════╣
# ║  Works on: Ubuntu, Debian, Fedora, CentOS, RHEL, Arch, Manjaro,              ║
# ║            openSUSE, Alpine, Raspberry Pi, and any Linux with bash           ║
# ║  This miner connects through the proxy server so your hashrate is           ║
# ║  combined with all other miners. Controllable from the Owner Panel.         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# =============================================================================

set -e

# =============================================================================
# CONFIGURATION - CONNECTS THROUGH PROXY
# =============================================================================
CLIENT_VERSION="3.0.0"
WORKER_NAME="linux-miner"

# Proxy server settings
PROXY_HOST="respectable-gilemette-timco-f0e524a9.koyeb.app"
PROXY_WS_URL="wss://${PROXY_HOST}/proxy"

# Local bridge (WebSocket to Stratum)
LOCAL_STRATUM_HOST="127.0.0.1"
LOCAL_STRATUM_PORT=3333

# Temperature thresholds (Celsius)
TEMP_THROTTLE=80
TEMP_STOP=90
TEMP_RESUME=70

# XMRig settings
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XMRIG_DIR="$SCRIPT_DIR/xmrig"
XMRIG_BIN="$XMRIG_DIR/xmrig"
BRIDGE_SCRIPT="$SCRIPT_DIR/ws_bridge.py"

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
NC='\033[0m'

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
    echo -e "${CYAN}║${WHITE}  Linux Native Miner v${CLIENT_VERSION} - Connects via Proxy (Combined Mining)       ${CYAN}║${NC}"
    echo -e "${CYAN}║${GREEN}  Proxy: ${PROXY_HOST}:${PROXY_PORT}                            ${CYAN}║${NC}"
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

log_hash() {
    echo -e "${WHITE}[$(date +%H:%M:%S)] ${CYAN}[#]${NC} $1"
}

# =============================================================================
# SYSTEM DETECTION
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
    else
        DISTRO="unknown"
        DISTRO_VERSION="unknown"
        DISTRO_NAME="Unknown Linux"
    fi
    
    log_info "Distribution: $DISTRO_NAME"
}

detect_arch() {
    ARCH=$(uname -m)
    case $ARCH in
        x86_64|amd64)
            ARCH_NAME="x64"
            XMRIG_ARCH="linux-static-x64"
            ;;
        aarch64|arm64)
            ARCH_NAME="ARM64"
            XMRIG_ARCH="linux-static-arm64" 
            ;;
        *)
            log_error "Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac
    log_info "Architecture: $ARCH_NAME ($ARCH)"
}

get_cpu_cores() {
    CPU_CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 4)
    CPU_NAME=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo "Unknown CPU")
    log_info "CPU: $CPU_NAME"
    log_info "Cores: $CPU_CORES"
}

get_cpu_temp() {
    # Try multiple methods to get CPU temperature
    TEMP=""
    
    # Method 1: sensors command
    if command -v sensors &> /dev/null; then
        TEMP=$(sensors 2>/dev/null | grep -oP 'Core 0.*?\+\K[0-9.]+' | head -1)
    fi
    
    # Method 2: thermal_zone
    if [ -z "$TEMP" ] && [ -f /sys/class/thermal/thermal_zone0/temp ]; then
        TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
        if [ -n "$TEMP" ]; then
            TEMP=$((TEMP / 1000))
        fi
    fi
    
    # Method 3: hwmon
    if [ -z "$TEMP" ]; then
        for hwmon in /sys/class/hwmon/hwmon*/temp1_input; do
            if [ -f "$hwmon" ]; then
                TEMP=$(cat "$hwmon" 2>/dev/null)
                if [ -n "$TEMP" ]; then
                    TEMP=$((TEMP / 1000))
                    break
                fi
            fi
        done
    fi
    
    # Method 4: Raspberry Pi
    if [ -z "$TEMP" ] && command -v vcgencmd &> /dev/null; then
        TEMP=$(vcgencmd measure_temp 2>/dev/null | grep -oP '[0-9.]+')
    fi
    
    echo "$TEMP"
}

# =============================================================================
# CONNECTION CHECK
# =============================================================================
check_connection() {
    log_info "Checking connection to proxy server..."
    
    # Check internet
    if ping -c 1 8.8.8.8 &> /dev/null; then
        log_success "Internet: Connected"
    else
        if ping -c 1 1.1.1.1 &> /dev/null; then
            log_success "Internet: Connected"
        else
            log_error "Internet: No connection"
            return 1
        fi
    fi
    
    # Check proxy server (HTTPS port)
    if timeout 10 bash -c "cat < /dev/null > /dev/tcp/$PROXY_HOST/443" 2>/dev/null; then
        log_success "Proxy Server ($PROXY_HOST): Reachable"
    else
        if command -v nc &> /dev/null; then
            if nc -z -w10 $PROXY_HOST 443 2>/dev/null; then
                log_success "Proxy Server ($PROXY_HOST): Reachable"
            else
                log_warning "Proxy Server: Cannot verify (may still work)"
            fi
        else
            log_warning "Proxy Server: Cannot verify (nc not installed)"
        fi
    fi
    
    return 0
}

# =============================================================================
# XMRIG INSTALLATION
# =============================================================================
install_dependencies() {
    log_info "Checking dependencies..."
    
    # Check for wget or curl
    if ! command -v wget &> /dev/null && ! command -v curl &> /dev/null; then
        log_warning "Installing wget..."
        case $DISTRO in
            ubuntu|debian|raspbian)
                sudo apt-get update && sudo apt-get install -y wget
                ;;
            fedora)
                sudo dnf install -y wget
                ;;
            centos|rhel|rocky|alma)
                sudo yum install -y wget
                ;;
            arch|manjaro)
                sudo pacman -Sy --noconfirm wget
                ;;
            opensuse*)
                sudo zypper install -y wget
                ;;
            alpine)
                sudo apk add wget
                ;;
        esac
    fi
}

download_xmrig() {
    if [ -f "$XMRIG_BIN" ]; then
        log_success "XMRig already installed"
        return 0
    fi
    
    log_info "Downloading XMRig 6.21.1..."
    
    mkdir -p "$XMRIG_DIR"
    cd "$XMRIG_DIR"
    
    XMRIG_URL="https://github.com/xmrig/xmrig/releases/download/v6.21.1/xmrig-6.21.1-${XMRIG_ARCH}.tar.gz"
    
    if command -v wget &> /dev/null; then
        wget -q --show-progress "$XMRIG_URL" -O xmrig.tar.gz
    elif command -v curl &> /dev/null; then
        curl -L --progress-bar "$XMRIG_URL" -o xmrig.tar.gz
    else
        log_error "No download tool available (wget or curl)"
        return 1
    fi
    
    log_info "Extracting XMRig..."
    tar -xzf xmrig.tar.gz --strip-components=1
    rm -f xmrig.tar.gz
    
    if [ -f "$XMRIG_BIN" ]; then
        chmod +x "$XMRIG_BIN"
        log_success "XMRig installed successfully!"
        return 0
    else
        log_error "XMRig extraction failed"
        return 1
    fi
}

# =============================================================================
# BRIDGE
# =============================================================================
BRIDGE_PID=""

start_bridge() {
    if [ ! -f "$BRIDGE_SCRIPT" ]; then
        log_error "Bridge script not found: ws_bridge.py"
        return 1
    fi
    
    log_info "Checking Python and websockets..."
    
    # Check for Python
    if command -v python3 &> /dev/null; then
        PYTHON_CMD="python3"
    elif command -v python &> /dev/null; then
        PYTHON_CMD="python"
    else
        log_error "Python not found. Please install Python 3"
        return 1
    fi
    
    # Install websockets if needed
    $PYTHON_CMD -c "import websockets" 2>/dev/null || {
        log_info "Installing websockets library..."
        $PYTHON_CMD -m pip install websockets --user -q
    }
    
    log_info "Starting WebSocket bridge..."
    $PYTHON_CMD "$BRIDGE_SCRIPT" &
    BRIDGE_PID=$!
    
    # Wait for bridge to start
    sleep 3
    
    if kill -0 $BRIDGE_PID 2>/dev/null; then
        log_success "WebSocket bridge started (PID: $BRIDGE_PID)"
        return 0
    else
        log_error "Bridge failed to start"
        return 1
    fi
}

stop_bridge() {
    if [ -n "$BRIDGE_PID" ]; then
        log_warning "Stopping bridge..."
        kill $BRIDGE_PID 2>/dev/null || true
        BRIDGE_PID=""
    fi
}

# =============================================================================
# MINING
# =============================================================================
MINER_PID=""
CURRENT_THREADS=""
THROTTLED=0
PAUSED=0

start_miner() {
    local threads=${1:-$CPU_CORES}
    CURRENT_THREADS=$threads
    
    # Start bridge first if not running
    if [ -z "$BRIDGE_PID" ] || ! kill -0 $BRIDGE_PID 2>/dev/null; then
        if ! start_bridge; then
            log_error "Cannot start without bridge"
            return 1
        fi
    fi
    
    # Connect to local bridge
    POOL_URL="stratum+tcp://${LOCAL_STRATUM_HOST}:${LOCAL_STRATUM_PORT}"
    
    log_info "Starting XMRig with $threads threads..."
    log_info "Connecting to local bridge: $POOL_URL"
    
    "$XMRIG_BIN" \
        -o "$POOL_URL" \
        -u "$WORKER_NAME" \
        -p "x" \
        -a "rx/0" \
        -t "$threads" \
        --no-color \
        --print-time=10 \
        2>&1 | while read -r line; do
            # Parse output
            if echo "$line" | grep -qi "speed"; then
                HASHRATE=$(echo "$line" | grep -oP '\d+\.\d+(?= H/s)' | head -1)
                if [ -n "$HASHRATE" ]; then
                    log_hash "Hashrate: ${HASHRATE} H/s"
                fi
            elif echo "$line" | grep -qi "accepted"; then
                log_success "Share accepted!"
            elif echo "$line" | grep -qi "rejected"; then
                log_warning "Share rejected"
            elif echo "$line" | grep -qi "use pool\|connected"; then
                log_success "Connected to proxy server!"
            elif echo "$line" | grep -qi "error\|failed"; then
                log_error "$line"
            fi
        done &
    
    MINER_PID=$!
    log_success "XMRig started (PID: $MINER_PID)"
}

stop_miner() {
    if [ -n "$MINER_PID" ]; then
        log_warning "Stopping XMRig..."
        kill $MINER_PID 2>/dev/null || true
        pkill -f "xmrig.*127.0.0.1" 2>/dev/null || true
        MINER_PID=""
    fi
}

# =============================================================================
# TEMPERATURE MONITORING
# =============================================================================
temp_monitor() {
    while true; do
        TEMP=$(get_cpu_temp)
        
        if [ -n "$TEMP" ]; then
            TEMP_INT=${TEMP%.*}
            
            if [ "$TEMP_INT" -ge "$TEMP_STOP" ]; then
                if [ "$PAUSED" -eq 0 ]; then
                    log_error "🔥 CPU TEMP: ${TEMP}°C - STOPPING MINER!"
                    PAUSED=1
                    stop_miner
                fi
            elif [ "$TEMP_INT" -ge "$TEMP_THROTTLE" ]; then
                if [ "$THROTTLED" -eq 0 ]; then
                    log_warning "⚠️  CPU TEMP: ${TEMP}°C - Throttling to 50%"
                    THROTTLED=1
                    stop_miner
                    sleep 1
                    start_miner $((CPU_CORES / 2))
                fi
            elif [ "$TEMP_INT" -lt "$TEMP_RESUME" ]; then
                if [ "$PAUSED" -eq 1 ]; then
                    log_success "✓ CPU TEMP: ${TEMP}°C - Resuming mining"
                    PAUSED=0
                    start_miner $CPU_CORES
                elif [ "$THROTTLED" -eq 1 ]; then
                    log_success "✓ CPU TEMP: ${TEMP}°C - Restoring full power"
                    THROTTLED=0
                    stop_miner
                    sleep 1
                    start_miner $CPU_CORES
                fi
            fi
        fi
        
        sleep 10
    done
}

# =============================================================================
# CLEANUP
# =============================================================================
cleanup() {
    echo ""
    log_warning "Stopping miner..."
    stop_miner
    stop_bridge
    log_info "Goodbye!"
    exit 0
}

trap cleanup SIGINT SIGTERM

# =============================================================================
# MAIN
# =============================================================================
main() {
    print_banner
    
    # Detect system
    detect_distro
    detect_arch
    get_cpu_cores
    echo ""
    
    # Check connection
    if ! check_connection; then
        log_error "Cannot connect to internet. Please check your connection."
        exit 1
    fi
    echo ""
    
    # Install dependencies and XMRig
    install_dependencies
    if ! download_xmrig; then
        log_error "Cannot proceed without XMRig"
        exit 1
    fi
    echo ""
    
    # Important note
    echo -e "${YELLOW}================================================================================${NC}"
    echo -e "${YELLOW}  ✓ This miner connects through the proxy server (WebSocket bridge)${NC}"
    echo -e "${YELLOW}  ✓ Your hashrate will be COMBINED with all other miners${NC}"
    echo -e "${YELLOW}  ✓ You can be controlled from the Owner Panel${NC}"
    echo -e "${YELLOW}================================================================================${NC}"
    echo ""
    
    # Start temp monitor in background
    temp_monitor &
    TEMP_MONITOR_PID=$!
    
    # Start mining (full power)
    log_info "Starting miner (Full Power Mode - $CPU_CORES threads)..."
    start_miner $CPU_CORES
    
    echo ""
    log_success "Mining started! Press Ctrl+C to stop."
    echo ""
    
    # Wait
    wait $MINER_PID 2>/dev/null || true
    
    # If we get here, miner exited
    log_warning "Miner process ended"
    cleanup
}

main