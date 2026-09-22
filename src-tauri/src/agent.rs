use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct TestAiRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TestAiResponse {
    pub success: bool,
    pub message: String,
    pub latency_ms: u64,
}

pub struct AgentService;

impl AgentService {
    pub async fn test_connection(req: TestAiRequest) -> TestAiResponse {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build();

        let client = match client {
            Ok(c) => c,
            Err(e) => {
                return TestAiResponse {
                    success: false,
                    message: format!("客户端初始化失败: {}", e),
                    latency_ms: 0,
                }
            }
        };

        let url = format!("{}/chat/completions", req.base_url.trim_end_matches('/'));
        let start = std::time::Instant::now();

        let body = serde_json::json!({
            "model": req.model,
            "messages": [
                {"role": "user", "content": "ping"}
            ],
            "max_tokens": 5
        });

        let mut request = client.post(&url).json(&body);
        if !req.api_key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", req.api_key));
        }

        match request.send().await {
            Ok(resp) => {
                let status = resp.status();
                let latency_ms = start.elapsed().as_millis() as u64;
                if status.is_success() {
                    TestAiResponse {
                        success: true,
                        message: format!("连接成功 (HTTP {})", status.as_u16()),
                        latency_ms,
                    }
                } else {
                    let err_text = resp.text().await.unwrap_or_default();
                    TestAiResponse {
                        success: false,
                        message: format!("连接失败 (HTTP {}): {}", status.as_u16(), err_text),
                        latency_ms,
                    }
                }
            }
            Err(e) => TestAiResponse {
                success: false,
                message: format!("网络连接异常: {}", e),
                latency_ms: start.elapsed().as_millis() as u64,
            },
        }
    }
}
