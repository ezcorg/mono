import type { Messages } from "../index";

const en: Messages = {
  // ── App ──
  app_name: { message: "ezfilter" },
  app_tagline: { message: "your friendly content filter" },
  app_get_started: { message: "Get started" },
  app_sign_in: { message: "Sign In" },

  // ── Common ──
  common_save: { message: "Save" },
  common_saving: { message: "Saving..." },
  common_saved: { message: "Saved!" },
  common_back: { message: "Back" },
  common_continue: { message: "Continue" },
  common_dismiss: { message: "Dismiss" },
  common_email: { message: "Email" },
  common_password: { message: "Password" },
  common_loading: { message: "Loading..." },
  common_from: { message: "From" },
  common_to: { message: "To" },
  common_optional: { message: "optional" },

  // ── Navigation ──
  nav_plugins: { message: "Plugins" },
  nav_settings: { message: "Settings" },
  nav_logout: { message: "Logout" },
  nav_start: { message: "Start" },
  nav_stop: { message: "Stop" },

  // ── Setup wizard ──
  setup_heading: { message: "Let's get you set up" },

  setup_hosting_title: { message: "How would you like to run it?" },
  setup_hosting_description: { message: "Choose between our managed service or your own server" },
  setup_hosting_managed_label: { message: "Managed by us" },
  setup_hosting_managed_desc: {
    message:
      "We handle everything for you. Your instance runs privately in an environment supporting confidential computing, where we never have access to your data.",
  },
  setup_hosting_selfhost_label: { message: "Self-hosted" },
  setup_hosting_selfhost_desc: {
    message: "Connect to another backend, hosted and maintained by you or someone else.",
  },

  setup_has_server_title: { message: "Do you have a running server?" },
  setup_has_server_desc: {
    message:
      "If you already have a witmproxy instance running, we can connect to it directly.",
  },
  setup_has_server_yes: { message: "Yes, I have a server" },
  setup_has_server_yes_desc: { message: "I'll provide the URL to my running instance" },
  setup_has_server_local: { message: "No \u2014 set up locally" },
  setup_has_server_local_desc: {
    message: "We'll help you install and configure witmproxy on this machine",
  },
  setup_has_server_remote: { message: "No \u2014 set up remotely" },
  setup_has_server_remote_desc: {
    message: "I'll deploy witmproxy on my own infrastructure",
  },

  setup_local_title: { message: "Local setup" },
  setup_local_desc: {
    message: "We'll check for witmproxy on your machine and help you get it running.",
  },
  setup_local_binary_label: { message: "witmproxy binary" },
  setup_local_detecting: { message: "Detecting..." },
  setup_local_found: { message: "Found" },
  setup_local_not_found: { message: "Not found" },
  setup_local_pending: { message: "Pending" },
  setup_local_not_detected: {
    message:
      "witmproxy was not detected on your system. You can download it or point to an existing binary.",
  },
  setup_local_download: { message: "Download" },
  setup_local_browse: { message: "Browse..." },
  setup_local_recheck: { message: "Re-check" },
  setup_local_configure: { message: "Configure proxy" },
  setup_local_configure_desc: {
    message:
      "These actions will install the CA certificate, trust it in your system store, and start the proxy service.",
  },
  setup_local_path_label: { message: "Binary path" },
  setup_local_path_hint: { message: "Edit to use a different binary" },
  setup_local_path_valid: { message: "Valid witmproxy binary" },
  setup_local_path_invalid: { message: "Not a valid witmproxy binary" },
  setup_local_path_checking: { message: "Verifying..." },
  setup_local_step_running: { message: "Service running" },
  setup_local_step_running_desc: { message: "Check if witmproxy is already running" },
  setup_local_step_ca: { message: "CA trusted" },
  setup_local_step_ca_desc: { message: "Install and trust the root certificate" },
  setup_local_step_proxy: { message: "System proxy" },
  setup_local_step_proxy_desc: { message: "Route traffic through witmproxy" },
  setup_local_check: { message: "Check" },
  setup_local_install: { message: "Install" },
  setup_local_trust: { message: "Trust" },
  setup_local_enable: { message: "Enable" },
  setup_local_done: { message: "Done" },
  setup_local_running: { message: "Proxy is running and ready" },
  setup_local_select_binary: { message: "Select witmproxy binary" },

  setup_remote_title: { message: "Remote deployment" },
  setup_remote_desc: {
    message: "Deploy witmproxy on your own infrastructure, then come back here with the URL.",
  },
  setup_remote_self_manage: {
    message: "You'll need to set up and manage the server yourself. Our documentation covers:",
  },
  setup_remote_doc_docker: { message: "Docker / docker-compose deployment" },
  setup_remote_doc_systemd: { message: "Systemd service configuration" },
  setup_remote_doc_tls: { message: "TLS certificate setup" },
  setup_remote_doc_env: { message: "Environment variables & configuration" },
  setup_remote_open_docs: { message: "Open documentation" },
  setup_remote_ready: { message: "Once your server is running, click Continue to enter its URL." },

  setup_server_title: { message: "Where's your server?" },
  setup_server_desc: { message: "Enter the URL of your witmproxy web server" },
  setup_server_url_label: { message: "Server URL" },
  setup_server_url_placeholder: { message: "https://my-proxy.example.com" },
  setup_server_url_hint: { message: "The full URL including protocol (https://)" },
  setup_server_healthy: { message: "Server is reachable and healthy" },
  setup_server_tls_error: { message: "TLS certificate error" },
  setup_server_enter_url: { message: "Please enter a server URL" },
  setup_server_wait_health: { message: "Waiting for health check to complete..." },

  setup_login_title: { message: "Sign in to your account" },
  setup_login_desc_managed: { message: "Sign in with your ezfilter account" },
  setup_login_desc_selfhost: { message: "Sign in to your server at $1" },
  setup_login_email_placeholder: { message: "you@example.com" },
  setup_login_password_placeholder: { message: "Your password" },
  setup_login_btn: { message: "Sign In" },
  setup_login_btn_loading: { message: "Signing in..." },
  setup_login_no_account: { message: "Don't have an account?" },
  setup_login_sign_up: { message: "Sign up" },

  setup_signup_title: { message: "Create an account" },
  setup_signup_desc_managed: { message: "Create your ezfilter account" },
  setup_signup_desc_selfhost: { message: "Register on your server at $1" },
  setup_signup_password_placeholder: { message: "Choose a password" },
  setup_signup_btn: { message: "Create Account" },
  setup_signup_btn_loading: { message: "Creating account..." },
  setup_signup_has_account: { message: "Already have an account?" },
  setup_signup_sign_in: { message: "Sign in" },

  // ── Validation / errors ──
  error_enter_credentials: { message: "Please enter your email and password" },
  error_login_failed: { message: "Login failed. Check your credentials and server URL." },
  error_register_failed: { message: "Registration failed." },
  error_managed_signup: {
    message: "Account registration is not yet available for managed hosting. Please use self-hosting for now.",
  },
  error_invalid_url_protocol: { message: "URL must start with http:// or https://" },
  error_invalid_url: { message: "Please enter a valid URL (e.g. https://my-server:9443)" },
  error_server_status: { message: "Server responded with $1 $2" },
  error_server_unreachable: {
    message: "Could not reach the server. Make sure it is running and the URL is correct.",
  },
  error_tls: {
    message:
      "TLS/SSL error \u2014 the server's certificate may be self-signed or untrusted. If running locally, make sure you have trusted the certificate or use http:// instead.",
  },

  // ── Plugins page ──
  plugins_title: { message: "Plugins" },
  plugins_subtitle: { message: "Configure your internet experience" },
  plugins_search_placeholder: { message: "Search plugins..." },
  plugins_import: { message: "Import plugin" },
  plugins_importing: { message: "Importing..." },
  plugins_refresh: { message: "Refresh" },
  plugins_import_failed: { message: "Failed to import plugin" },
  plugins_load_failed: { message: "Failed to load plugins" },
  plugins_none_found: { message: "No plugins found" },
  plugins_none_installed: { message: "No plugins installed" },
  plugins_try_search: { message: "Try a different search term" },
  plugins_get_started: { message: "Upload a plugin to get started" },
  plugins_active: { message: "Active" },
  plugins_disabled: { message: "Disabled" },
  plugins_configure: { message: "Configure" },
  plugins_delete: { message: "Remove plugin" },
  plugins_delete_confirm: { message: "Remove this plugin? This cannot be undone." },
  plugins_homepage: { message: "Homepage" },
  plugins_license: { message: "License: $1" },
  plugins_toggle_enable: { message: "Enable" },
  plugins_toggle_disable: { message: "Disable" },
  plugins_review_capabilities: { message: "Review Capabilities" },
  plugins_review_caps_desc: { message: "This plugin was installed with the following capabilities." },
  plugins_capability: { message: "Capability" },
  plugins_capability_scope: { message: "Scope" },
  plugins_approve_install: { message: "Done" },
  plugins_cancel: { message: "Cancel" },

  // ── Plugin config page ──
  plugin_config_title: { message: "Plugin Configuration" },
  plugin_config_subtitle: { message: "Configure how this plugin behaves" },
  plugin_config_no_caps: { message: "This plugin does not request any capabilities." },
  plugin_config_configuration: { message: "Configuration" },
  plugin_config_save: { message: "Save Configuration" },
  plugin_config_select: { message: "Select an option" },
  plugin_config_file_upload: { message: "Click to upload a file" },
  plugin_config_binary_upload: { message: "Click to upload binary data" },
  plugin_config_no_settings: { message: "This plugin has no configurable settings." },
  plugin_config_capabilities: { message: "Capabilities" },
  plugin_config_caps_desc: { message: "Permissions and scopes granted to this plugin" },
  plugin_config_cap_granted: { message: "Granted" },
  plugin_config_cap_denied: { message: "Denied" },
  plugin_config_scope_label: { message: "Filter expression" },

  // ── Settings page ──
  settings_title: { message: "Settings" },
  settings_subtitle: { message: "Manage your app and proxy preferences" },

  settings_appearance: { message: "Appearance" },
  settings_theme: { message: "Theme" },

  settings_connection: { message: "Connection" },
  settings_mode: { message: "Mode" },
  settings_server_url: { message: "Server URL" },
  settings_not_configured: { message: "not configured" },
  settings_change_url: { message: "Change server URL" },
  settings_apply: { message: "Apply" },

  settings_proxy_title: { message: "Proxy Configuration" },
  settings_proxy_desc: { message: "Runtime settings for the witmproxy server" },
  settings_proxy_loading: { message: "Loading configuration..." },
  settings_proxy_unavailable: {
    message: "Could not load server configuration. Make sure you're connected.",
  },
  settings_plugins_label: { message: "Plugins" },
  settings_plugins_desc: { message: "Enable or disable the plugin system" },
  settings_timeout: { message: "Plugin timeout (ms)" },
  settings_memory: { message: "Max plugin memory (MB)" },
  settings_fuel: { message: "WASM fuel limit" },
  settings_autoupdate: { message: "Auto-update" },
  settings_autoupdate_desc: { message: "Automatically update the proxy in daemon mode" },
  settings_transparent: { message: "Transparent proxy" },
  settings_transparent_desc: { message: "Intercept traffic via iptables/nftables" },

  settings_profile_title: { message: "Profile" },
  settings_profile_email: { message: "Email" },
  settings_profile_password: { message: "Change password" },
  settings_profile_new_password: { message: "New password" },
  settings_profile_icon: { message: "Profile icon" },
  settings_profile_icon_desc: { message: "An emoji that sparks joy" },

  settings_dev_title: { message: "Developer" },
  settings_dev_mode: { message: "Developer mode" },
  settings_dev_mode_desc: { message: "Show developer tools and debug information" },
  settings_dev_actions: { message: "Debug actions" },
  settings_dev_clear: { message: "Clear storage & reset" },
  settings_dev_clear_confirm: {
    message: "Clear all app storage and reload? You'll need to go through setup again.",
  },
  settings_dev_reload: { message: "Force reload" },
};

export default en;
