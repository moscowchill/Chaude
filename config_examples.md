```
vendors:
    aws-bedrock:
      config:
        aws_access_key: YOUR_AWS_ACCESS_KEY_HERE
        aws_secret_key: YOUR_AWS_SECRET_KEY_HERE
        #aws_region: us-west-2  # Optional, defaults to us-west-2
      provides: ["anthropic\\.claude.*"]  # Match Bedrock model names
    anthropic-steering-preview:
        config:
             anthropic_api_key: "YOUR_ANTHROPIC_API_KEY_HERE"
        provides:
            - "claude-3-sonnet-20240229-steering-preview"
            - "claude-3-5-haiku-20241022"
            - "claude-3-sonnet-20240229"
            - "claude-sonnet-4-20250514"
            - "claude-3-7-sonnet-20250219"
            - "claude-opus-4-20250514"
            - "claude-3-opus-20240229"
            - "claude-3-5-sonnet-20241022"
            - "claude-3-5-sonnet-20240620"
            - "claude-opus-4-1-20250805"
    anthropic-antra:
      config:
        anthropic_api_key: "YOUR_ANTHROPIC_API_KEY_HERE"
      provides:
            - "claudeaa-opusaa-4-1-20250805"
```

```
name: Claude 3 Opus
# message_history_header: "\n<realtime>\n"
continuation_model: "claude-3-opus-20240229"
recency_window: 700
continuation_max_tokens: 500
temperature: 1.0
top_p: 1.0
max_queued_replies: 1
frequency_penalty: 0
presence_penalty: 0
message_history_format:
  name: colon
split_message: false
reply_on_random: 250000
reply_on_name: false
stop_sequences:
  - "\nHuman:"
  - "\nClaude:"
```