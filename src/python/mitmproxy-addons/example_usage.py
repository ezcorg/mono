#!/usr/bin/env python3
"""
Example usage script for the YouTube Data Interceptor addon.

This script demonstrates how to run mitmproxy with the YouTube interceptor addon
and provides some helper functions for working with the captured data.
"""

import subprocess
import sys
import os
from pathlib import Path


def install_dependencies():
    """Install required dependencies."""
    print("Installing dependencies...")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
        print("Dependencies installed successfully!")
    except subprocess.CalledProcessError as e:
        print(f"Failed to install dependencies: {e}")
        return False
    return True


def run_mitmdump():
    """Run mitmdump with the YouTube interceptor addon."""
    addon_path = Path(__file__).parent / "youtube_interceptor.py"

    if not addon_path.exists():
        print(f"Error: Addon file not found at {addon_path}")
        return

    print(f"Starting mitmdump with YouTube interceptor addon...")
    print(f"Addon path: {addon_path}")
    print("\nConfigure your browser to use proxy: 127.0.0.1:8080")
    print("For HTTPS, visit http://mitm.it to install the certificate")
    print("\nPress Ctrl+C to stop the proxy")

    try:
        subprocess.run([
            "mitmdump",
            "-s", str(addon_path),
            "--set", "confdir=~/.mitmproxy"
        ])
    except KeyboardInterrupt:
        print("\nProxy stopped.")
    except FileNotFoundError:
        print("Error: mitmdump not found. Please install mitmproxy first:")
        print("pip install mitmproxy")


def run_mitmweb():
    """Run mitmweb with the YouTube interceptor addon."""
    addon_path = Path(__file__).parent / "youtube_interceptor.py"

    if not addon_path.exists():
        print(f"Error: Addon file not found at {addon_path}")
        return

    print(f"Starting mitmweb with YouTube interceptor addon...")
    print(f"Addon path: {addon_path}")
    print("\nWeb interface will be available at: http://127.0.0.1:8081")
    print("Configure your browser to use proxy: 127.0.0.1:8080")
    print("For HTTPS, visit http://mitm.it to install the certificate")
    print("\nPress Ctrl+C to stop the proxy")

    try:
        subprocess.run([
            "mitmweb",
            "-s", str(addon_path),
            "--set", "confdir=~/.mitmproxy"
        ])
    except KeyboardInterrupt:
        print("\nProxy stopped.")
    except FileNotFoundError:
        print("Error: mitmweb not found. Please install mitmproxy first:")
        print("pip install mitmproxy")


def main():
    """Main function to handle command line arguments."""
    if len(sys.argv) < 2:
        print("YouTube Data Interceptor - Example Usage")
        print("\nUsage:")
        print("  python example_usage.py install    - Install dependencies")
        print("  python example_usage.py mitmdump   - Run with mitmdump (command line)")
        print("  python example_usage.py mitmweb    - Run with mitmweb (web interface)")
        print("\nAfter starting the proxy:")
        print("1. Configure your browser to use 127.0.0.1:8080 as HTTP/HTTPS proxy")
        print("2. Visit http://mitm.it to install the certificate for HTTPS")
        print("3. Navigate to any YouTube page")
        print("4. Open browser console to see logged ytInitialData")
        return

    command = sys.argv[1].lower()

    if command == "install":
        install_dependencies()
    elif command == "mitmdump":
        run_mitmdump()
    elif command == "mitmweb":
        run_mitmweb()
    else:
        print(f"Unknown command: {command}")
        print("Use 'install', 'mitmdump', or 'mitmweb'")


if __name__ == "__main__":
    main()
