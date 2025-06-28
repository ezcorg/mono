# YouTube Data Interceptor - mitmproxy Addon

This mitmproxy addon intercepts HTTP responses from YouTube domains and injects JavaScript code to log the `window.ytInitialData` object to the browser console.

## Features

- Intercepts responses from YouTube domains (youtube.com, m.youtube.com, www.youtube.com, music.youtube.com)
- Parses HTML responses and injects logging script
- Logs `window.ytInitialData` to browser console in formatted JSON
- Monitors for changes to `ytInitialData` and logs updates
- Stores captured data in `window._capturedYtInitialData` for easy access
- Dispatches custom events when data is captured

## Installation

1. Install dependencies:
```bash
pip install -r requirements.txt
```

## Usage

### With mitmdump (command line)
```bash
mitmdump -s youtube_interceptor.py
```

### With mitmproxy (interactive)
```bash
mitmproxy -s youtube_interceptor.py
```

### With mitmweb (web interface)
```bash
mitmweb -s youtube_interceptor.py
```

## Configuration

Configure your browser to use mitmproxy as a proxy:
- HTTP Proxy: 127.0.0.1:8080
- HTTPS Proxy: 127.0.0.1:8080

For HTTPS interception, you'll need to install mitmproxy's certificate:
1. Start mitmproxy
2. Navigate to http://mitm.it in your browser
3. Download and install the certificate for your platform

## What Gets Logged

The addon injects JavaScript that:

1. **Immediate logging**: Logs `window.ytInitialData` as soon as the script runs
2. **DOM ready logging**: Logs data when DOM is fully loaded
3. **Delayed logging**: Additional attempts after 1s and 3s delays
4. **Change monitoring**: Monitors for updates to `ytInitialData` every 2 seconds
5. **Global storage**: Stores data in `window._capturedYtInitialData`
6. **Custom events**: Dispatches `ytInitialDataCaptured` event

## Console Output Example

```javascript
=== YouTube Initial Data ===
{
  "contents": {
    "videoDetails": {
      "videoId": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up",
      // ... more data
    }
  }
}
=== End YouTube Initial Data ===
```

## Accessing Captured Data

From browser console:
```javascript
// Access the captured data
console.log(window._capturedYtInitialData);

// Listen for capture events
window.addEventListener('ytInitialDataCaptured', function(event) {
    console.log('New data captured:', event.detail);
});
```

## Troubleshooting

1. **No data logged**: Ensure the page is actually a YouTube page with `ytInitialData`
2. **Certificate errors**: Install mitmproxy's certificate for HTTPS interception
3. **Proxy not working**: Check browser proxy settings
4. **Script not injected**: Check mitmproxy logs for errors

## Supported Domains

- youtube.com
- m.youtube.com  
- www.youtube.com
- music.youtube.com

## Notes

- The addon only processes HTML responses
- JavaScript injection happens in the `<head>` section
- Multiple logging attempts ensure data capture even with dynamic loading
- The script is designed to be non-intrusive and not affect page functionality