//! A mock HTTP server's request reader (tests only), copied from core's
//! `test_support` so this crate stays independent of core.

use std::io::Read;
use std::time::Duration;

/// One request as a mock server saw it.
pub(crate) struct MockHttpRequest {
    /// `"POST /v1/systemone HTTP/1.1"`.
    pub(crate) request_line: String,
    pub(crate) body: serde_json::Value,
    pub(crate) authorization: Option<String>,
}

/// Read one HTTP/1.1 request from a mock-server connection: the request line,
/// the JSON body and the `authorization` header, if any.
pub(crate) fn read_http_request_full(stream: &mut std::net::TcpStream) -> MockHttpRequest {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).unwrap();
        assert!(read > 0, "connection closed before request body");
        request.extend_from_slice(&buffer[..read]);
        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            let body_start = header_end + 4;
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_len = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .expect("content-length");
            if request.len() >= body_start + content_len {
                let authorization = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_string())
                });
                let body =
                    serde_json::from_slice(&request[body_start..body_start + content_len]).unwrap();
                return MockHttpRequest {
                    request_line: headers.lines().next().unwrap_or_default().to_string(),
                    body,
                    authorization,
                };
            }
        }
    }
}
