use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;

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

#[derive(Debug, Serialize, Deserialize)]
pub struct StreamAiChatRequest {
    pub request_id: String,
    pub base_url: String,
    pub api_key: String,
    pub body: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiStreamEvent {
    pub event_type: String, // "chunk" | "error" | "done"
    pub data: Option<String>,
}

#[derive(Clone)]
pub struct AgentService {
    aborted_requests: Arc<Mutex<HashSet<String>>>,
    client: Client,
}

impl AgentService {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            aborted_requests: Arc::new(Mutex::new(HashSet::new())),
            client,
        }
    }

    pub fn abort_chat(&self, request_id: &str) {
        if let Ok(mut set) = self.aborted_requests.lock() {
            set.insert(request_id.to_string());
        }
    }

    fn is_aborted(&self, request_id: &str) -> bool {
        if let Ok(set) = self.aborted_requests.lock() {
            set.contains(request_id)
        } else {
            false
        }
    }

    fn clear_aborted(&self, request_id: &str) {
        if let Ok(mut set) = self.aborted_requests.lock() {
            set.remove(request_id);
        }
    }

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
        if !req.api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", req.api_key.trim()));
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

    pub async fn stream_chat(
        &self,
        req: StreamAiChatRequest,
        channel: Channel<AiStreamEvent>,
    ) -> Result<(), String> {
        self.clear_aborted(&req.request_id);
        let url = format!("{}/chat/completions", req.base_url.trim_end_matches('/'));
        let mut request = self.client.post(&url).json(&req.body);
        if !req.api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", req.api_key.trim()));
        }

        let resp_result = request.send().await;
        let mut resp = match resp_result {
            Ok(r) => r,
            Err(e) => {
                let err_msg = format!("大模型网络请求失败: {}", e);
                let _ = channel.send(AiStreamEvent {
                    event_type: "error".to_string(),
                    data: Some(err_msg.clone()),
                });
                return Err(err_msg);
            }
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let err_body = resp.text().await.unwrap_or_default();
            let err_msg = format!("LLM API 响应错误 (HTTP {}): {}", status, err_body);
            let _ = channel.send(AiStreamEvent {
                event_type: "error".to_string(),
                data: Some(err_msg.clone()),
            });
            return Err(err_msg);
        }

        let mut pending_bytes: Vec<u8> = Vec::new();

        while let Ok(Some(chunk)) = resp.chunk().await {
            if self.is_aborted(&req.request_id) {
                break;
            }

            pending_bytes.extend_from_slice(&chunk);

            match std::str::from_utf8(&pending_bytes) {
                Ok(valid_str) => {
                    let text = valid_str.to_string();
                    pending_bytes.clear();
                    if channel
                        .send(AiStreamEvent {
                            event_type: "chunk".to_string(),
                            data: Some(text),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        let valid_str = match std::str::from_utf8(&pending_bytes[..valid_up_to]) {
                            Ok(s) => s.to_string(),
                            Err(_) => {
                                String::from_utf8_lossy(&pending_bytes[..valid_up_to]).to_string()
                            }
                        };
                        pending_bytes.drain(..valid_up_to);
                        if channel
                            .send(AiStreamEvent {
                                event_type: "chunk".to_string(),
                                data: Some(valid_str),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    if e.error_len().is_some() {
                        let lossy_str = String::from_utf8_lossy(&pending_bytes).to_string();
                        pending_bytes.clear();
                        if channel
                            .send(AiStreamEvent {
                                event_type: "chunk".to_string(),
                                data: Some(lossy_str),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        }

        if !pending_bytes.is_empty() && !self.is_aborted(&req.request_id) {
            let lossy_str = String::from_utf8_lossy(&pending_bytes).to_string();
            let _ = channel.send(AiStreamEvent {
                event_type: "chunk".to_string(),
                data: Some(lossy_str),
            });
        }

        self.clear_aborted(&req.request_id);
        let _ = channel.send(AiStreamEvent {
            event_type: "done".to_string(),
            data: None,
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_service_abort() {
        let agent = AgentService::new();
        assert!(!agent.is_aborted("req-test-1"));
        agent.abort_chat("req-test-1");
        assert!(agent.is_aborted("req-test-1"));
        agent.clear_aborted("req-test-1");
        assert!(!agent.is_aborted("req-test-1"));
    }
}

