//! 传输层聚合：Graph 主通道 + IMAP 兜底。

pub mod graph_client;
pub mod imap_client;

pub use graph_client::{GraphClient, GraphRequestError, GraphResponseTooLargeError};
pub use imap_client::{ImapClient, ImapError};
