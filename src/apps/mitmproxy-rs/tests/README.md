# End-to-End Tests for MITM Proxy

This directory contains comprehensive end-to-end tests for the MITM proxy with WASM plugin system.

## Test Overview

The end-to-end test (`e2e_test.rs`) performs the following:

1. **Plugin Building**: Automatically compiles all example plugins to WASM
2. **Sample Service**: Starts a test HTTP service with various endpoints
3. **Proxy Setup**: Initializes the MITM proxy with all plugins loaded
4. **Plugin Testing**: Tests each plugin's functionality through real HTTP requests
5. **Cleanup**: Properly tears down all services and cleans up temporary files

## Test Structure

### Sample Service (`sample_service.rs`)

The sample service provides various endpoints to test different plugin functionality:

- **HTML Endpoints**:
  - `/` - Home page with external scripts and links
  - `/login` - Login form with password field (tests security warnings)
  - `/form` - Forms with and without CSRF tokens
  - `/external-links` - Page with safe and unsafe external links

- **JSON API Endpoints**:
  - `/api/data` - Normal API response
  - `/api/user` - User data with ID
  - `/api/error` - Error response (400 status)
  - `/api/sensitive` - Response with sensitive data fields
  - `/large-response` - Large JSON response (>1MB)

### Plugin Tests

#### Logger Plugin Test
- Makes requests through the proxy
- Verifies requests are logged with proper metadata
- Tests request timing and host counting

#### JSON Validator Plugin Test
- Tests JSON request/response processing
- Verifies detection of sensitive fields (password, api_key, etc.)
- Tests error response handling
- Verifies large response size warnings

#### HTML Analyzer Plugin Test
- Tests HTML page structure analysis
- Verifies security issue detection:
  - Forms without CSRF tokens
  - Password fields on non-HTTPS pages
  - External links without `rel="noopener"`
- Tests metadata extraction (title, links, forms count)
- Verifies external domain monitoring

## Running the Tests

### Prerequisites

1. **Rust with WASM target**:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

2. **Dependencies**: All required dependencies are specified in `Cargo.toml`

### Running All Tests

```bash
# From the mitmproxy-rs directory
cargo test --test e2e_test
```

### Running Specific Tests

```bash
# Test only plugin loading
cargo test --test e2e_test test_plugin_loading

# Test full end-to-end functionality
cargo test --test e2e_test test_e2e_mitm_proxy_with_plugins
```

### Verbose Output

```bash
# Run with verbose output to see detailed logs
cargo test --test e2e_test -- --nocapture
```

## Test Configuration

The tests use the following ports (automatically chosen to avoid conflicts):

- **Proxy**: 18080
- **Web Interface**: 18081  
- **Sample Service**: 18082

## What the Tests Verify

### Plugin Loading
- All example plugins compile to WASM successfully
- Plugin manager loads all plugins correctly
- Plugin metadata is accessible

### Logger Plugin
- Logs all HTTP requests and responses
- Tracks request timing and duration
- Counts requests per host
- Logs interesting headers (User-Agent, Referer)

### JSON Validator Plugin
- Processes JSON requests and responses
- Detects sensitive data fields in requests
- Logs API errors and large responses
- Validates required fields for API endpoints

### HTML Analyzer Plugin
- Analyzes page structure (links, forms, scripts)
- Detects security issues:
  - Missing CSRF tokens in forms
  - Password fields on non-HTTPS pages
  - Unsafe external links
- Extracts page metadata
- Monitors external resource references

### Integration
- All plugins work together without conflicts
- Proxy correctly routes requests through plugins
- Plugin storage and analytics work properly
- Services start and stop cleanly

## Troubleshooting

### Plugin Build Failures
If plugin builds fail, ensure:
- `wasm32-unknown-unknown` target is installed
- All plugin dependencies are available
- Plugin source code compiles individually

### Service Startup Issues
If services fail to start:
- Check that ports are not already in use
- Verify network permissions
- Check for firewall restrictions

### Test Timeouts
If tests timeout:
- Increase `TEST_TIMEOUT` constant in `e2e_test.rs`
- Check system resources (CPU, memory)
- Verify no other processes are interfering

## Extending the Tests

To add new plugin tests:

1. **Add Plugin**: Create new plugin in `plugins/examples/`
2. **Update Build**: Add plugin name to the `plugins` array in `build_plugins()`
3. **Add Test Method**: Create new test method in `E2ETestSetup`
4. **Update Main Test**: Call new test method in `test_e2e_mitm_proxy_with_plugins()`

To add new sample service endpoints:

1. **Add Handler**: Add new handler function in `sample_service.rs`
2. **Add Route**: Register route in `SampleService::start()`
3. **Add Test**: Create test that exercises the new endpoint

## Performance Considerations

The tests are designed to:
- Run quickly (typically under 30 seconds)
- Use minimal system resources
- Clean up properly after execution
- Avoid port conflicts with other services

## Security Notes

The tests use:
- Self-signed certificates (for testing only)
- Insecure HTTP connections (intentional for testing)
- Hardcoded sensitive data (for plugin testing)

These are appropriate for testing but should never be used in production.