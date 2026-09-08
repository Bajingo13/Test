CREATE TABLE IF NOT EXISTS ai_recon_conversations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NULL,
  title VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES bank_recon_sessions(id) ON DELETE SET NULL,
  INDEX idx_ai_conv_created_by (created_by)
);

CREATE TABLE IF NOT EXISTS ai_recon_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT,
  tool_calls JSON NULL,
  tool_results JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES ai_recon_conversations(id) ON DELETE CASCADE,
  INDEX idx_ai_msg_conversation (conversation_id, id)
);
