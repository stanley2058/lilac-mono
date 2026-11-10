if not type_is(KEYS[1], "stream", false) then return {"panic", "source-type"} end
if not type_is(KEYS[2], "zset", true) or not type_is(KEYS[3], "zset", true) or not type_is(KEYS[4], "zset", true) then
  return {"panic", "index-type"}
end
if not type_is(KEYS[5], "string", true) then return {"panic", "cursor-type"} end

local group = ARGV[1]
local consumer = ARGV[2]
local owner_id = ARGV[3]
local token = ARGV[4]
local state_prefix = ARGV[5]
local lease_ms = tonumber(ARGV[6])
local limit = tonumber(ARGV[7])
local now = now_ms()

local function state_key(id)
  return state_prefix .. id
end

local function require_source_and_pending(id)
  if not source_exists(KEYS[1], id) then return nil, "source-missing" end
  local pending = pending_owner(KEYS[1], group, id)
  if pending == nil then return nil, "pending-missing" end
  if pending == false then return nil, "pending-malformed" end
  return pending, nil
end

local function validate_candidate(id, expected_state, index_score)
  local key = state_key(id)
  if not type_is(key, "hash", false) then return nil, "state-type" end
  if redis.call("HGET", key, "version") ~= "2" or redis.call("HGET", key, "id") ~= id
    or redis.call("HGET", key, "state") ~= expected_state then return nil, "state-malformed" end
  local delivery_id = redis.call("HGET", key, "delivery_id")
  local attempt = expected_state == "claimed" and valid_completed_attempts(redis.call("HGET", key, "attempt"))
    or valid_attempt(redis.call("HGET", key, "attempt"))
  if not delivery_id or string.len(delivery_id) ~= 64 or string.find(delivery_id, "[^0-9a-f]") or attempt == nil then
    return nil, "state-malformed"
  end
  local persisted_score = expected_state == "retry-scheduled" and valid_deadline(redis.call("HGET", key, "due_at"))
    or valid_deadline(redis.call("HGET", key, "lease_deadline"))
  if not persisted_score or persisted_score ~= index_score then return nil, "index-mismatch" end
  if expected_state == "retry-scheduled" then
    if tonumber(redis.call("ZSCORE", KEYS[2], id)) ~= persisted_score or redis.call("ZSCORE", KEYS[3], id)
      or redis.call("ZSCORE", KEYS[4], id) then return nil, "index-mismatch" end
  elseif expected_state == "claimed" or expected_state == "in-flight" then
    if tonumber(redis.call("ZSCORE", KEYS[3], id)) ~= persisted_score or redis.call("ZSCORE", KEYS[2], id)
      or redis.call("ZSCORE", KEYS[4], id) then return nil, "index-mismatch" end
  else
    if tonumber(redis.call("ZSCORE", KEYS[4], id)) ~= persisted_score or redis.call("ZSCORE", KEYS[2], id)
      or redis.call("ZSCORE", KEYS[3], id) then return nil, "index-mismatch" end
  end
  return {key, delivery_id, attempt}, nil
end

local function validate_reason(raw)
  local ok, reason = pcall(cjson.decode, raw or "")
  if not ok or type(reason) ~= "table" then return nil end
  if reason.kind == "handler-error" then
    if type(reason.errorTag) ~= "string" or string.len(reason.errorTag) > 512
      or type(reason.errorMessage) ~= "string" or string.len(reason.errorMessage) > 512 then return nil end
  elseif reason.kind == "contract-invalid" then
    local stages = {transport=true, envelope=true, event_type=true, headers=true, topic=true, key=true, payload=true}
    if reason.diagnostic ~= "event_bus.contract_invalid" or not stages[reason.stage]
      or (reason.eventType ~= nil and (type(reason.eventType) ~= "string" or string.len(reason.eventType) > 512))
      or type(reason.issues) ~= "table" or #reason.issues > 32 then return nil end
    for _, issue in ipairs(reason.issues) do
      if type(issue) ~= "string" or string.len(issue) > 512 then return nil end
    end
  elseif reason.kind == "attempts-exhausted" then
    local failure = reason.finalFailure
    if type(failure) ~= "table" then return nil end
    if failure.kind == "handler-error" then
      if type(failure.errorTag) ~= "string" or string.len(failure.errorTag) > 512
        or type(failure.errorMessage) ~= "string" or string.len(failure.errorMessage) > 512 then return nil end
    elseif failure.kind ~= "lease-expired" then return nil end
  else return nil end
  return raw
end

for index = 8, #ARGV, 2 do
  local id = ARGV[index]
  local delivery_id = ARGV[index + 1]
  if not valid_stream_id(id) or not delivery_id or string.len(delivery_id) ~= 64
    or string.find(delivery_id, "[^0-9a-f]") then return {"panic", "orphan-identity-malformed"} end
  local key = state_key(id)
  if redis.call("EXISTS", key) == 0 then
    if pending_owner(KEYS[1], group, id) ~= nil then
    if redis.call("ZSCORE", KEYS[2], id) or redis.call("ZSCORE", KEYS[3], id)
      or redis.call("ZSCORE", KEYS[4], id) then return {"panic", "index-orphan"} end
    local _, pending_error = require_source_and_pending(id)
    if pending_error then return {"panic", pending_error} end
    if not claim_source(KEYS[1], group, consumer, id) then return {"panic", "claim-failed"} end
    local deadline = now + lease_ms
    redis.call("HSET", key, "version", "2", "id", id, "delivery_id", delivery_id, "state", "claimed",
      "attempt", "0", "token", token, "owner_id", owner_id, "consumer_id", consumer,
      "lease_deadline", tostring(deadline))
    redis.call("ZADD", KEYS[3], deadline, id)
    return {"claimed", id, "0", token, delivery_id, tostring(deadline)}
    end
  elseif not type_is(key, "hash", false) then return {"panic", "state-type"} end
end

local cursor = redis.call("GET", KEYS[5]) or "-"
if cursor ~= "-" and not valid_stream_id(cursor) then return {"panic", "cursor-malformed"} end
local start = cursor == "-" and "-" or "(" .. cursor
local pending = redis.call("XPENDING", KEYS[1], group, start, "+", limit)
local orphan_ids = {}
for _, entry in ipairs(pending) do
  if type(entry) ~= "table" or #entry < 4 or type(entry[1]) ~= "string" or type(entry[2]) ~= "string"
    or type(entry[3]) ~= "number" or type(entry[4]) ~= "number" then return {"panic", "pending-malformed"} end
  local id = entry[1]
  local key = state_key(id)
  if redis.call("EXISTS", key) == 0 then
    if redis.call("ZSCORE", KEYS[2], id) or redis.call("ZSCORE", KEYS[3], id)
      or redis.call("ZSCORE", KEYS[4], id) then return {"panic", "index-orphan"} end
    table.insert(orphan_ids, id)
  elseif not type_is(key, "hash", false) then return {"panic", "state-type"} end
end
if #pending < limit then redis.call("SET", KEYS[5], "-")
else redis.call("SET", KEYS[5], pending[#pending][1]) end
if #orphan_ids > 0 then return {"orphans", orphan_ids} end

local terminal = redis.call("ZRANGEBYSCORE", KEYS[4], "-inf", now, "WITHSCORES", "LIMIT", 0, limit)
for index = 1, #terminal, 2 do
  local id = terminal[index]
  local score = tonumber(terminal[index + 1])
  local key = state_key(id)
  if not type_is(key, "hash", false) then return {"panic", "state-type"} end
  local terminal_state = redis.call("HGET", key, "state")
  if terminal_state ~= "terminal-preparing" and terminal_state ~= "dead-letter-pending" then
    return {"panic", "state-malformed"}
  end
  local candidate, candidate_error = validate_candidate(id, terminal_state, score)
  if candidate_error then return {"panic", candidate_error} end
  if terminal_state == "terminal-preparing" then
    local reason = validate_reason(redis.call("HGET", candidate[1], "terminal_reason"))
    if not reason then return {"panic", "terminal-reason-malformed"} end
    local _, pending_error = require_source_and_pending(id)
    if pending_error then return {"panic", pending_error} end
    if not claim_source(KEYS[1], group, consumer, id) then return {"panic", "claim-failed"} end
    local deadline = now + lease_ms
    redis.call("HSET", candidate[1], "token", token, "owner_id", owner_id, "consumer_id", consumer,
      "lease_deadline", tostring(deadline))
    redis.call("ZADD", KEYS[4], deadline, id)
    return {"prepare-terminal", id, tostring(candidate[3]), token, candidate[2], tostring(deadline), reason}
  end
  local terminal_id = redis.call("HGET", candidate[1], "terminal_id")
  local record_key = redis.call("HGET", candidate[1], "terminal_record_key")
  local record_value = redis.call("HGET", candidate[1], "terminal_record_value")
  local has_evidence = redis.call("HGET", candidate[1], "terminal_has_evidence")
  local evidence_key = redis.call("HGET", candidate[1], "terminal_evidence_key")
  local evidence_value = redis.call("HGET", candidate[1], "terminal_evidence_value")
  local index_key = redis.call("HGET", candidate[1], "terminal_index_key")
  local index_max_len = redis.call("HGET", candidate[1], "terminal_index_max_len")
  local ttl_seconds = redis.call("HGET", candidate[1], "terminal_ttl_seconds")
  local parsed_max_len = tonumber(index_max_len)
  local parsed_ttl = tonumber(ttl_seconds)
  local index_score = valid_deadline(redis.call("HGET", candidate[1], "terminal_index_score"))
  local fields_json = redis.call("HGET", candidate[1], "terminal_index_fields")
  local ok, fields = pcall(cjson.decode, fields_json or "")
  if not terminal_id or terminal_id == "" or not record_key or record_key == "" or not record_value or record_value == ""
    or not index_key or index_key == "" or not parsed_max_len or parsed_max_len < 1 or parsed_max_len ~= math.floor(parsed_max_len)
    or not parsed_ttl or parsed_ttl < 1 or parsed_ttl ~= math.floor(parsed_ttl)
    or (has_evidence ~= "0" and has_evidence ~= "1") or (has_evidence == "1" and (not evidence_key or not evidence_value))
    or not index_score or not ok or type(fields) ~= "table" or #fields == 0
    or #fields > 32 or #fields % 2 ~= 0 then return {"panic", "terminal-malformed"} end
  for field_index, value in ipairs(fields) do
    if type(value) ~= "string" or string.len(value) > 1024 or (field_index % 2 == 1 and value == "") then
      return {"panic", "terminal-malformed"}
    end
  end
  local _, pending_error = require_source_and_pending(id)
  if pending_error then return {"panic", pending_error} end
  if not claim_source(KEYS[1], group, consumer, id) then return {"panic", "claim-failed"} end
  local deadline = now + lease_ms
  redis.call("HSET", candidate[1], "token", token, "owner_id", owner_id, "consumer_id", consumer,
    "lease_deadline", tostring(deadline))
  redis.call("ZADD", KEYS[4], deadline, id)
  return {"terminal", id, tostring(candidate[3]), token, candidate[2], tostring(deadline),
    terminal_id, record_key, record_value, has_evidence, evidence_key or "", evidence_value or "", index_key, fields,
    tostring(index_score), index_max_len, ttl_seconds}
end

local due = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", now, "WITHSCORES", "LIMIT", 0, limit)
for index = 1, #due, 2 do
  local id = due[index]
  local score = tonumber(due[index + 1])
  local candidate, candidate_error = validate_candidate(id, "retry-scheduled", score)
  if candidate_error then return {"panic", candidate_error} end
  local _, pending_error = require_source_and_pending(id)
  if pending_error then return {"panic", pending_error} end
  if candidate[3] >= 5 then return {"panic", "due-attempt-exhausted"} end
  if not claim_source(KEYS[1], group, consumer, id) then return {"panic", "claim-failed"} end
  local deadline = now + lease_ms
  redis.call("HSET", candidate[1], "state", "claimed", "token", token, "owner_id", owner_id,
    "consumer_id", consumer, "lease_deadline", tostring(deadline))
  redis.call("HDEL", candidate[1], "due_at")
  redis.call("ZREM", KEYS[2], id)
  redis.call("ZADD", KEYS[3], deadline, id)
  redis.call("ZREM", KEYS[4], id)
  return {"claimed", id, tostring(candidate[3]), token, candidate[2], tostring(deadline)}
end

local expired = redis.call("ZRANGEBYSCORE", KEYS[3], "-inf", now, "WITHSCORES", "LIMIT", 0, limit)
for index = 1, #expired, 2 do
  local id = expired[index]
  local score = tonumber(expired[index + 1])
  local key = state_key(id)
  if not type_is(key, "hash", false) then return {"panic", "state-type"} end
  local expired_state = redis.call("HGET", key, "state")
  if expired_state ~= "claimed" and expired_state ~= "in-flight" then return {"panic", "state-malformed"} end
  local candidate, candidate_error = validate_candidate(id, expired_state, score)
  if candidate_error then return {"panic", candidate_error} end
  local _, pending_error = require_source_and_pending(id)
  if pending_error then return {"panic", pending_error} end
  if not claim_source(KEYS[1], group, consumer, id) then return {"panic", "claim-failed"} end
  local deadline = now + lease_ms
  if expired_state == "in-flight" then
    redis.call("HSET", candidate[1], "failure_kind", "lease-expired")
    redis.call("HDEL", candidate[1], "failure_tag", "failure_message")
  end
  redis.call("HSET", candidate[1], "state", "claimed", "token", token, "owner_id", owner_id,
    "consumer_id", consumer, "lease_deadline", tostring(deadline))
  redis.call("ZADD", KEYS[3], deadline, id)
  if candidate[3] == 5 then
    local failure_kind = redis.call("HGET", candidate[1], "failure_kind")
    if failure_kind == "handler-error" then
      local tag = redis.call("HGET", candidate[1], "failure_tag")
      local message = redis.call("HGET", candidate[1], "failure_message")
      if not tag or not message then return {"panic", "state-malformed"} end
      return {"exhausted", id, "5", token, candidate[2], tostring(deadline), failure_kind, tag, message}
    end
    if failure_kind ~= "lease-expired" then return {"panic", "state-malformed"} end
    return {"exhausted", id, "5", token, candidate[2], tostring(deadline), failure_kind, "", ""}
  end
  return {"claimed", id, tostring(candidate[3]), token, candidate[2], tostring(deadline)}
end

return {"none"}
