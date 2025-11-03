# WIT Publishing Documentation

This document describes the WebAssembly Interface Types (WIT) publishing functionality for the witmproxy project.

## Overview

The witmproxy project now supports automatic publishing of its WIT interface to GitHub Container Registry (ghcr.io) using the `wkg` (WebAssembly Package Tools) system. This enables other developers to easily consume the witmproxy plugin interface in their own projects.

## Automatic Publishing

### GitHub Actions Workflow

The WIT package is automatically published to ghcr.io when:

1. **Changes to WIT files**: When `src/apps/witmproxy/wit/world.wit` is modified and pushed to the `main` branch
2. **Manual trigger**: When the workflow is manually triggered via GitHub Actions with an optional version parameter

The GitHub Actions workflow is defined in [`.github/workflows/witmproxy-wit-publish.yml`](.github/workflows/witmproxy-wit-publish.yml).

### Package Location

The published WIT package is available at:
```
ghcr.io/{repository-owner}/witmproxy/plugin:{version}
```

For example:
```
ghcr.io/ezcorg/witmproxy/plugin:0.0.1
```

## Manual Publishing

### Requirements

To publish the WIT package manually, you need:

1. **wkg tool**: Install with `cargo install wasm-pkg-tools`
2. **Authentication**: GitHub token with packages:write permission
3. **Repository access**: Access to push to the ghcr.io registry

### Using the Script

The publishing script is located at [`src/scripts/publish-wit.sh`](src/scripts/publish-wit.sh).

#### Basic Usage

```bash
# Publish with version from Cargo.toml
./src/scripts/publish-wit.sh "" your-org

# Publish with specific version
./src/scripts/publish-wit.sh 0.1.0 your-org

# Show help
./src/scripts/publish-wit.sh --help
```

#### Environment Variables

Set the following environment variables for authentication:

```bash
export GITHUB_TOKEN="your-github-token"
export GITHUB_REPOSITORY_OWNER="your-org"
```

#### Example

```bash
# Set up authentication
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"

# Publish version 0.1.0 to your organization
./src/scripts/publish-wit.sh 0.1.0 myorg
```

## Consuming the WIT Package

### Setup wkg Configuration

Create or edit your wkg configuration file (`~/.config/wasm-pkg/config.toml`):

```toml
default_registry = "ghcr.io"

[namespace_registries]
witmproxy = {
  registry = "witmproxy",
  metadata = {
    preferredProtocol = "oci",
    "oci" = {
      registry = "ghcr.io",
      namespacePrefix = "repository-owner/"
    }
  }
}
```

### Fetching the WIT Package

#### As WIT Files

```bash
# Fetch the WIT interface
wkg get --format wit witmproxy:plugin@0.0.1 --output plugin.wit
```

#### As WebAssembly Component

```bash
# Fetch the packaged component
wkg get witmproxy:plugin@0.0.1 --output plugin.wasm
```

#### Direct OCI Pull

```bash
# Pull directly from the OCI registry
wkg oci pull ghcr.io/ezcorg/witmproxy/plugin:0.0.1 -o plugin.wasm
```

### Using in Your Project

Once you have the WIT files, you can use them in your project:

1. **Place in dependencies**: Copy to your `wit/deps/` directory
2. **Import in your WIT**: Reference the interfaces in your world definitions
3. **Generate bindings**: Use your language's WIT tooling to generate bindings

Example world that imports the witmproxy plugin interface:

```wit
package my-app:plugin-consumer@0.1.0;

world my-plugin {
    import witmproxy:plugin/witm-plugin@0.0.1;
    import witmproxy:plugin/capabilities@0.0.1;
    
    // Your plugin implementation
}
```

## WIT Interface Overview

The witmproxy WIT interface (`witmproxy:plugin@0.0.1`) defines:

### Interfaces

1. **`capabilities`**: Provides plugin capability management including:
   - `annotator-client`: Content annotation capabilities
   - `local-storage-client`: Key-value storage capabilities
   - `capability-provider`: Manages access to capabilities

2. **`witm-plugin`**: Main plugin interface including:
   - `manifest()`: Returns plugin metadata
   - `handle-request()`: Processes HTTP requests
   - `handle-response()`: Processes HTTP responses

### World

The `plugin` world defines the contract that witmproxy plugins must implement:
- Imports the `capabilities` interface for accessing host capabilities
- Exports the `witm-plugin` interface for plugin functionality

## Versioning

WIT packages are versioned according to the version specified in [`src/apps/witmproxy/Cargo.toml`](src/apps/witmproxy/Cargo.toml). When publishing:

1. **Automatic versioning**: Uses the version from `Cargo.toml`
2. **Manual versioning**: Can override with a specific version parameter
3. **Semantic versioning**: Follow semantic versioning practices for compatibility

## Security Considerations

- **Registry authentication**: Ensure your GitHub token has appropriate permissions
- **Package visibility**: Published packages are public by default on ghcr.io
- **Version immutability**: Published versions cannot be overwritten

## Troubleshooting

### Common Issues

1. **Authentication errors**: Check your GitHub token permissions
2. **Registry access**: Ensure you have push access to the registry
3. **wkg not found**: Install with `cargo install wasm-pkg-tools`
4. **Build failures**: Ensure the WIT files are syntactically correct

### Debug Mode

Run the script with debug information:

```bash
bash -x src/scripts/publish-wit.sh 0.1.0 myorg
```

### Testing Locally

Validate the WIT files without publishing:

```bash
# Just build the WIT component
cd src/apps/witmproxy
wkg wit build --wit-dir wit
```

## Related Documentation

- [WebAssembly Package Tools (wkg)](https://github.com/bytecodealliance/wasm-pkg-tools)
- [Component Model Documentation](https://component-model.bytecodealliance.org/)
- [GitHub Container Registry Documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)