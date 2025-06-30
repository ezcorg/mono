// MITM Proxy Dashboard JavaScript

class Dashboard {
    constructor() {
        this.refreshInterval = 30000; // 30 seconds
        this.intervalId = null;
        this.init();
    }

    init() {
        this.loadDashboardData();
        this.startAutoRefresh();
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Add refresh button if it exists
        const refreshBtn = document.getElementById('refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.loadDashboardData());
        }

        // Add plugin toggle buttons
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('plugin-toggle')) {
                this.togglePlugin(e.target.dataset.plugin, e.target.dataset.action);
            }
        });
    }

    async loadDashboardData() {
        try {
            await Promise.all([
                this.loadHealthStatus(),
                this.loadStatistics(),
                this.loadPlugins(),
                this.loadLogs()
            ]);

            this.updateLastRefresh();
        } catch (error) {
            console.error('Failed to load dashboard data:', error);
            this.showError('Failed to load dashboard data');
        }
    }

    async loadHealthStatus() {
        try {
            const response = await fetch('/api/health');
            const health = await response.json();

            this.updateElement('server-status', health.status);
            this.updateElement('version', health.version || 'Unknown');

            // Update status indicator
            const statusElement = document.getElementById('server-status');
            if (statusElement) {
                statusElement.className = `status ${health.status === 'healthy' ? 'healthy' : 'error'}`;
            }

        } catch (error) {
            console.error('Failed to load health status:', error);
            this.updateElement('server-status', 'Error');
            this.updateElement('version', 'Unknown');
        }
    }

    async loadStatistics() {
        try {
            const response = await fetch('/api/stats');
            const stats = await response.json();

            // Update certificate cache info
            if (stats.certificate_cache) {
                const cacheInfo = `${stats.certificate_cache.size}/${stats.certificate_cache.max_size}`;
                this.updateElement('cert-cache', cacheInfo);
            }

            // Update connection info
            if (stats.connections) {
                this.updateElement('active-connections', stats.connections.active || 'N/A');
                this.updateElement('total-requests', stats.connections.total || 'N/A');
            }

        } catch (error) {
            console.error('Failed to load statistics:', error);
            this.updateElement('cert-cache', 'Error');
            this.updateElement('active-connections', 'Error');
            this.updateElement('total-requests', 'Error');
        }
    }

    async loadPlugins() {
        try {
            const response = await fetch('/api/plugins');
            const data = await response.json();

            const pluginsList = document.getElementById('plugins-list');
            if (!pluginsList) return;

            if (data.plugins.length === 0) {
                pluginsList.innerHTML = '<p class="text-muted">No plugins loaded</p>';
            } else {
                pluginsList.innerHTML = data.plugins.map(plugin => `
                    <div class="plugin-item">
                        <div>
                            <div class="plugin-name">${plugin.name}</div>
                            <div class="text-muted">${plugin.description || 'No description'}</div>
                        </div>
                        <div>
                            <span class="plugin-status ${plugin.enabled ? 'enabled' : 'disabled'}">
                                ${plugin.enabled ? 'Enabled' : 'Disabled'}
                            </span>
                            <button class="btn btn-sm plugin-toggle" 
                                    data-plugin="${plugin.name}" 
                                    data-action="${plugin.enabled ? 'disable' : 'enable'}">
                                ${plugin.enabled ? 'Disable' : 'Enable'}
                            </button>
                        </div>
                    </div>
                `).join('');
            }

        } catch (error) {
            console.error('Failed to load plugins:', error);
            const pluginsList = document.getElementById('plugins-list');
            if (pluginsList) {
                pluginsList.innerHTML = '<p class="text-muted">Error loading plugins</p>';
            }
        }
    }

    async loadLogs() {
        try {
            const response = await fetch('/api/plugins/logs');
            const data = await response.json();

            const logsList = document.getElementById('logs-list');
            if (!logsList) return;

            if (data.logs.length === 0) {
                logsList.innerHTML = '<p class="text-muted">No recent logs</p>';
            } else {
                logsList.innerHTML = data.logs.slice(0, 10).map(log => `
                    <div class="log-entry ${log.level}">
                        <span class="log-level">${log.level}:</span> 
                        <span class="log-message">${log.message}</span>
                        ${log.timestamp ? `<span class="log-time">(${new Date(log.timestamp).toLocaleTimeString()})</span>` : ''}
                    </div>
                `).join('');
            }

        } catch (error) {
            console.error('Failed to load logs:', error);
            const logsList = document.getElementById('logs-list');
            if (logsList) {
                logsList.innerHTML = '<p class="text-muted">Error loading logs</p>';
            }
        }
    }

    async togglePlugin(pluginName, action) {
        try {
            const response = await fetch(`/api/plugins/${pluginName}/${action}`, {
                method: 'POST'
            });

            if (response.ok) {
                // Reload plugins to update the UI
                await this.loadPlugins();
                this.showSuccess(`Plugin ${pluginName} ${action}d successfully`);
            } else {
                throw new Error(`Failed to ${action} plugin`);
            }

        } catch (error) {
            console.error(`Failed to ${action} plugin:`, error);
            this.showError(`Failed to ${action} plugin ${pluginName}`);
        }
    }

    updateElement(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
            element.classList.remove('loading');
        }
    }

    updateLastRefresh() {
        const element = document.getElementById('last-refresh');
        if (element) {
            element.textContent = new Date().toLocaleTimeString();
        }
    }

    startAutoRefresh() {
        this.intervalId = setInterval(() => {
            this.loadDashboardData();
        }, this.refreshInterval);
    }

    stopAutoRefresh() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    showError(message) {
        this.showNotification(message, 'error');
    }

    showSuccess(message) {
        this.showNotification(message, 'success');
    }

    showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `alert ${type} fade-in`;
        notification.textContent = message;

        // Add to page
        const container = document.querySelector('.container');
        if (container) {
            container.insertBefore(notification, container.firstChild);

            // Remove after 5 seconds
            setTimeout(() => {
                notification.remove();
            }, 5000);
        }
    }
}

// Certificate download functionality
class CertificateDownloader {
    constructor() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Handle certificate format selection
        document.addEventListener('change', (e) => {
            if (e.target.id === 'cert-format') {
                this.updateDownloadLinks(e.target.value);
            }
        });

        // Handle download button clicks
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('download-btn')) {
                this.trackDownload(e.target.href);
            }
        });
    }

    updateDownloadLinks(format) {
        const downloadBtn = document.getElementById('download-btn');
        const instructionsBtn = document.getElementById('instructions-btn');

        if (downloadBtn) {
            downloadBtn.href = `/cert?format=${format}&download=true`;
        }

        if (instructionsBtn) {
            instructionsBtn.href = `/cert?format=${format}`;
        }
    }

    trackDownload(url) {
        // Track download for analytics
        console.log('Certificate download:', url);

        // Could send analytics data here
        // fetch('/api/analytics/download', { method: 'POST', body: JSON.stringify({ url }) });
    }
}

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Initialize dashboard if we're on the dashboard page
    if (document.getElementById('dashboard')) {
        new Dashboard();
    }

    // Initialize certificate downloader on all pages
    new CertificateDownloader();

    // Add fade-in animation to main content
    const container = document.querySelector('.container');
    if (container) {
        container.classList.add('fade-in');
    }
});

// Export for use in other scripts
window.Dashboard = Dashboard;
window.CertificateDownloader = CertificateDownloader;