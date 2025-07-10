use axum::{
    extract::Query,
    http::StatusCode,
    response::{Html, Json},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

#[derive(Serialize, Deserialize)]
pub struct ApiResponse {
    pub message: String,
    pub data: serde_json::Value,
    pub timestamp: i64,
    pub user_id: Option<u64>,
}

#[derive(Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: u16,
    pub timestamp: i64,
}

#[derive(Serialize, Deserialize)]
pub struct SensitiveData {
    pub username: String,
    pub password: String,
    pub api_key: String,
    pub credit_card: String,
}

#[derive(Deserialize)]
pub struct QueryParams {
    pub test_type: Option<String>,
    pub user_id: Option<u64>,
}

pub struct SampleService {
    port: u16,
}

impl SampleService {
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let app = Router::new()
            .route("/", get(home_page))
            .route("/api/data", get(api_data))
            .route("/api/user", get(user_data))
            .route("/api/error", get(api_error))
            .route("/api/sensitive", get(sensitive_data))
            .route("/login", get(login_page))
            .route("/form", get(form_page))
            .route("/external-links", get(external_links_page))
            .route("/large-response", get(large_response))
            .layer(CorsLayer::permissive());

        let listener = TcpListener::bind(format!("127.0.0.1:{}", self.port)).await?;
        println!("Sample service listening on http://127.0.0.1:{}", self.port);

        axum::serve(listener, app).await?;
        Ok(())
    }
}

// HTML endpoints
async fn home_page() -> Html<&'static str> {
    Html(
        r#"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Sample service for testing MITM proxy plugins">
    <title>Sample Service - Home</title>
    <script src="https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js"></script>
</head>
<body>
    <h1>Sample Service</h1>
    <p>This is a test service for the MITM proxy.</p>
    <ul>
        <li><a href="/login">Login Page</a></li>
        <li><a href="/form">Form Page</a></li>
        <li><a href="/external-links">External Links Page</a></li>
        <li><a href="/api/data">API Data</a></li>
    </ul>
    <script>
        console.log('Home page loaded');
    </script>
</body>
</html>
    "#,
    )
}

async fn login_page() -> Html<&'static str> {
    Html(
        r#"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Login - Sample Service</title>
</head>
<body>
    <h1>Login</h1>
    <form action="/api/login" method="post">
        <div>
            <label for="username">Username:</label>
            <input type="text" id="username" name="username" required>
        </div>
        <div>
            <label for="password">Password:</label>
            <input type="password" id="password" name="password" required>
        </div>
        <button type="submit">Login</button>
    </form>
</body>
</html>
    "#,
    )
}

async fn form_page() -> Html<&'static str> {
    Html(
        r#"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Forms - Sample Service</title>
</head>
<body>
    <h1>Test Forms</h1>
    
    <h2>Form with CSRF Token</h2>
    <form action="/api/secure-action" method="post">
        <input type="hidden" name="_token" value="csrf-token-123">
        <input type="text" name="data" placeholder="Enter data">
        <button type="submit">Submit Secure</button>
    </form>
    
    <h2>Form without CSRF Token</h2>
    <form action="/api/insecure-action" method="post">
        <input type="text" name="data" placeholder="Enter data">
        <button type="submit">Submit Insecure</button>
    </form>
    
    <h2>GET Form</h2>
    <form action="/api/search" method="get">
        <input type="text" name="query" placeholder="Search query">
        <button type="submit">Search</button>
    </form>
</body>
</html>
    "#,
    )
}

async fn external_links_page() -> Html<&'static str> {
    Html(
        r#"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>External Links - Sample Service</title>
</head>
<body>
    <h1>External Links Test</h1>
    
    <h2>Safe External Links</h2>
    <a href="https://example.com" rel="noopener noreferrer">Safe External Link</a>
    
    <h2>Unsafe External Links</h2>
    <a href="https://malicious-site.com">Unsafe External Link</a>
    <a href="https://another-site.com" rel="nofollow">External Link without noopener</a>
    
    <h2>Internal Links</h2>
    <a href="/login">Internal Login Link</a>
    <a href="/api/data">Internal API Link</a>
    
    <script src="https://external-cdn.com/script.js"></script>
    <script src="/local-script.js"></script>
</body>
</html>
    "#,
    )
}

// JSON API endpoints
async fn api_data(Query(params): Query<QueryParams>) -> Json<ApiResponse> {
    let mut data = serde_json::Map::new();
    data.insert(
        "items".to_string(),
        serde_json::json!(["item1", "item2", "item3"]),
    );
    data.insert("count".to_string(), serde_json::json!(3));

    if let Some(test_type) = params.test_type {
        data.insert("test_type".to_string(), serde_json::json!(test_type));
    }

    Json(ApiResponse {
        message: "Data retrieved successfully".to_string(),
        data: serde_json::Value::Object(data),
        timestamp: chrono::Utc::now().timestamp_millis(),
        user_id: params.user_id,
    })
}

async fn user_data(Query(params): Query<QueryParams>) -> Json<ApiResponse> {
    let user_id = params.user_id.unwrap_or(123);

    let user_data = serde_json::json!({
        "id": user_id,
        "username": "testuser",
        "email": "test@example.com",
        "profile": {
            "name": "Test User",
            "age": 25
        }
    });

    Json(ApiResponse {
        message: "User data retrieved".to_string(),
        data: user_data,
        timestamp: chrono::Utc::now().timestamp_millis(),
        user_id: Some(user_id),
    })
}

async fn api_error() -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: "Something went wrong".to_string(),
            code: 400,
            timestamp: chrono::Utc::now().timestamp_millis(),
        }),
    )
}

async fn sensitive_data() -> Json<SensitiveData> {
    Json(SensitiveData {
        username: "admin".to_string(),
        password: "secret123".to_string(),
        api_key: "sk-1234567890abcdef".to_string(),
        credit_card: "4111-1111-1111-1111".to_string(),
    })
}

async fn large_response() -> Json<serde_json::Value> {
    // Create a large JSON response (over 1MB)
    let mut large_data = Vec::new();
    for i in 0..10000 {
        large_data.push(serde_json::json!({
            "id": i,
            "data": format!("This is item number {} with some additional data to make it larger", i),
            "metadata": {
                "created_at": chrono::Utc::now().timestamp_millis(),
                "tags": ["tag1", "tag2", "tag3"],
                "description": "A".repeat(100)  // 100 character string
            }
        }));
    }

    Json(serde_json::json!({
        "message": "Large dataset",
        "count": large_data.len(),
        "data": large_data
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{sleep, Duration};

    #[tokio::test]
    async fn test_sample_service_startup() {
        let service = SampleService::new(0); // Use port 0 for automatic assignment

        // Start service in background
        let handle = tokio::spawn(async move { service.start().await });

        // Give it a moment to start
        sleep(Duration::from_millis(100)).await;

        // The service should be running (we can't easily test the actual endpoints without knowing the port)
        assert!(!handle.is_finished());

        handle.abort();
    }
}
