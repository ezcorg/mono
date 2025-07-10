#[cfg(test)]
mod tests {
    use crate::proxy::{extract_host_from_headers, DnsResolver};

    #[tokio::test]
    async fn test_dns_resolver_empty_hostname() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test empty hostname
        let result = resolver.resolve("").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Empty hostname"));
    }

    #[tokio::test]
    async fn test_dns_resolver_whitespace_hostname() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test whitespace-only hostname
        let result = resolver.resolve("   ").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Empty hostname"));
    }

    #[tokio::test]
    async fn test_dns_resolver_invalid_hostname() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test hostname with invalid characters - let standard library handle validation
        let result = resolver.resolve("invalid\thostname\nwith\rcontrol").await;
        assert!(result.is_err());
        // Should fail on DNS resolution, not necessarily on format validation
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to resolve"));
    }

    #[tokio::test]
    async fn test_dns_resolver_valid_hostname_characters() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test that valid DNS characters are accepted (this will fail DNS resolution but pass validation)
        let result = resolver.resolve("valid-hostname_123.example.com").await;
        // Should fail on DNS resolution, not validation
        assert!(result.is_err());
        assert!(!result
            .unwrap_err()
            .to_string()
            .contains("Invalid hostname format"));
    }

    #[tokio::test]
    async fn test_dns_resolver_with_port() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test hostname with port - use a hostname that definitely won't resolve
        let result = resolver
            .resolve_with_port("nonexistent-hostname-12345.invalid:8080", 80)
            .await;
        // Should fail on DNS resolution but parse port correctly
        assert!(result.is_err());
        // Error should mention the hostname, not the port parsing
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("nonexistent-hostname-12345.invalid"));
    }

    #[tokio::test]
    async fn test_dns_resolver_localhost() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test localhost resolution (should work)
        let result = resolver.resolve_with_port("localhost", 80).await;
        assert!(result.is_ok());
        let addrs = result.unwrap();
        assert!(!addrs.is_empty());
        assert_eq!(addrs[0].port(), 80);
    }

    #[tokio::test]
    async fn test_dns_resolver_fallback() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test fallback resolution with localhost
        let result = resolver.resolve_with_fallback("localhost", 80).await;
        assert!(result.is_ok());
        let addr = result.unwrap();
        assert_eq!(addr.port(), 80);
    }

    #[tokio::test]
    async fn test_extract_host_from_headers_empty() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("host".to_string(), "".to_string());

        let result = extract_host_from_headers(&headers);
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_extract_host_from_headers_whitespace() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("host".to_string(), "   ".to_string());

        let result = extract_host_from_headers(&headers);
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_extract_host_from_headers_valid() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("host".to_string(), "  example.com  ".to_string());

        let result = extract_host_from_headers(&headers);
        assert_eq!(result, Some("example.com".to_string()));
    }

    #[tokio::test]
    async fn test_extract_host_from_headers_with_port() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("host".to_string(), "example.com:8080".to_string());

        let result = extract_host_from_headers(&headers);
        assert_eq!(result, Some("example.com:8080".to_string()));
    }

    #[tokio::test]
    async fn test_dns_resolver_ip_address() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test IPv4 address resolution (should work without DNS lookup)
        let result = resolver.resolve_with_port("127.0.0.1", 8080).await;
        if let Err(e) = &result {
            eprintln!("IPv4 test failed: {:?}", e);
        }
        assert!(result.is_ok(), "IPv4 resolution failed: {:?}", result.err());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 1);
        assert_eq!(
            addrs[0].ip(),
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(addrs[0].port(), 8080);

        // Test IPv6 address resolution
        let result = resolver.resolve_with_port("::1", 9090).await;
        if let Err(e) = &result {
            eprintln!("IPv6 test failed: {:?}", e);
        }
        assert!(result.is_ok(), "IPv6 resolution failed: {:?}", result.err());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 1);
        assert_eq!(
            addrs[0].ip(),
            std::net::IpAddr::V6(std::net::Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1))
        );
        assert_eq!(addrs[0].port(), 9090);

        // Test IP address with port in hostname (should parse correctly)
        let result = resolver.resolve_with_port("192.168.1.1:3000", 8080).await;
        assert!(result.is_ok());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 1);
        assert_eq!(
            addrs[0].ip(),
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 1))
        );
        assert_eq!(addrs[0].port(), 3000); // Should use port from hostname, not default
    }
}
