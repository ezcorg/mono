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
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("empty after trimming"));
    }

    #[tokio::test]
    async fn test_dns_resolver_invalid_hostname() {
        let resolver = DnsResolver::new().await.unwrap();

        // Test hostname with invalid characters
        let result = resolver.resolve("invalid hostname with spaces").await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Invalid hostname format"));
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
}
