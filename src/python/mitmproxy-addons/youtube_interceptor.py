"""
YouTube Data Interceptor - mitmproxy addon

This addon intercepts HTTP responses from YouTube domains (youtube.com, m.youtube.com)
and injects JavaScript code to log the window.ytInitialData object to the console.

Usage:
    mitmdump -s youtube_interceptor.py
    mitmproxy -s youtube_interceptor.py
"""

import re
from mitmproxy import http
from mitmproxy.script import concurrent
from bs4 import BeautifulSoup
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class YouTubeInterceptor:
    """
    Mitmproxy addon for intercepting YouTube responses and injecting data logging scripts.
    """

    def __init__(self):
        self.youtube_domains = [
            'youtube.com',
            'm.youtube.com',
            'www.youtube.com',
            'music.youtube.com'
        ]

        # JavaScript code to inject for logging ytInitialData
        self.injection_script = """
(function() {
    // Function to safely log ytInitialData
    function logYtInitialData() {
        if (typeof window.ytInitialData !== 'undefined') {
            console.log('=== YouTube Initial Data ===');
            console.log(JSON.stringify(window.ytInitialData, null, 2));
            console.log('=== End YouTube Initial Data ===');
            
            // Also store it in a global variable for easy access
            window._capturedYtInitialData = window.ytInitialData;
            
            // Dispatch a custom event for external scripts
            window.dispatchEvent(new CustomEvent('ytInitialDataCaptured', {
                detail: window.ytInitialData
            }));
        } else {
            console.log('ytInitialData not found on window object');
        }
    }
    
    // Try to log immediately if data is already available
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', logYtInitialData);
    } else {
        logYtInitialData();
    }
    
    // Also try after a short delay to catch dynamically loaded data
    setTimeout(logYtInitialData, 1000);
    setTimeout(logYtInitialData, 3000);
    
    // Monitor for changes to ytInitialData
    let lastYtData = null;
    setInterval(function() {
        if (window.ytInitialData && JSON.stringify(window.ytInitialData) !== lastYtData) {
            lastYtData = JSON.stringify(window.ytInitialData);
            console.log('=== YouTube Initial Data Updated ===');
            console.log(lastYtData);
            console.log('=== End Updated Data ===');
        }
    }, 2000);
})();
"""

    def is_youtube_domain(self, host):
        """Check if the host is a YouTube domain."""
        if not host:
            return False

        host = host.lower()
        return any(domain in host for domain in self.youtube_domains)

    def is_html_response(self, response):
        """Check if the response is HTML content."""
        content_type = response.headers.get('content-type', '').lower()
        return 'text/html' in content_type

    @concurrent
    def response(self, flow: http.HTTPFlow) -> None:
        """
        Intercept HTTP responses and inject logging script for YouTube domains.
        """
        try:
            # Check if this is a YouTube domain
            if not self.is_youtube_domain(flow.request.pretty_host):
                return

            # Check if this is an HTML response
            if not self.is_html_response(flow.response):
                return

            # Get the response content
            content = flow.response.get_text()
            if not content:
                return

            logger.info(
                f"Intercepting YouTube response: {flow.request.pretty_url}")

            # Parse HTML with BeautifulSoup
            try:
                soup = BeautifulSoup(content, 'html.parser')
            except Exception as e:
                logger.error(f"Failed to parse HTML: {e}")
                return

            # Find the head tag to inject our script
            head = soup.find('head')
            if not head:
                # If no head tag, try to find html tag and create head
                html_tag = soup.find('html')
                if html_tag:
                    head = soup.new_tag('head')
                    html_tag.insert(0, head)
                else:
                    logger.warning(
                        "No head or html tag found, cannot inject script")
                    return

            # Create script tag with our injection code
            script_tag = soup.new_tag('script')
            script_tag.string = self.injection_script.strip()

            # Insert the script at the beginning of head
            head.insert(0, script_tag)

            # Update the response content
            modified_content = str(soup)
            flow.response.set_text(modified_content)

            # Update content-length header
            flow.response.headers['content-length'] = str(
                len(modified_content.encode('utf-8')))

            logger.info(
                f"Successfully injected logging script into {flow.request.pretty_url}")

        except Exception as e:
            logger.error(
                f"Error processing response for {flow.request.pretty_url}: {e}")


# Create addon instance
addons = [YouTubeInterceptor()]


def load(loader):
    """Load the addon."""
    logger.info("YouTube Interceptor addon loaded")


def done():
    """Cleanup when addon is unloaded."""
    logger.info("YouTube Interceptor addon unloaded")
