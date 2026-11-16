//! Port of `scanLocalTextFile` in `packages/fs/src/text-scan.ts`.
//!
//! The scan decodes the file as UTF-8 with replacement characters, normalizes CRLF to LF, and
//! counts Unicode code points the way JavaScript's string iterator does. Core's parity tests run
//! the same files through both implementations.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::errors::FsError;
use crate::protocol::{ScanStart, ScanTextRequest};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashlineOverflow {
    line: u64,
    length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextScan {
    file_hash: String,
    window_lines: Vec<String>,
    total_lines: u64,
    selected_line_count: u64,
    first_selected_line_characters: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset_start_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset_start_column: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    normalized_start_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_next_line_offset: Option<u64>,
    source_offset: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    hashline_overflow: Option<HashlineOverflow>,
}

struct Scanner {
    start_line: u64,
    start_column: u64,
    start_offset: Option<u64>,
    offset_mode: bool,
    max_lines: u64,
    hashline_max_line_chars: u64,
    stored_line_limit: u64,
    stored_character_limit: u64,

    window_lines: Vec<String>,
    line_number: u64,
    selected_line_count: u64,
    stored_characters: u64,
    current_line: String,
    current_line_characters: u64,
    current_line_utf16: u64,
    first_selected_line_characters: u64,
    source_offset: u64,
    offset_start_line: Option<u64>,
    offset_start_column: Option<u64>,
    normalized_start_offset: Option<u64>,
    selected_next_line_offset: Option<u64>,
    hashline_overflow: Option<HashlineOverflow>,
    pending_cr: bool,
}

impl Scanner {
    fn new(request: &ScanTextRequest) -> Self {
        let (start_line, start_column, start_offset, offset_mode) = match request.start {
            ScanStart::Line { line, column } => (line, column, None, false),
            ScanStart::Offset { offset } => (1, 0, Some(offset), true),
        };
        Self {
            start_line,
            start_column,
            start_offset,
            offset_mode,
            max_lines: request.max_lines,
            hashline_max_line_chars: request.hashline_max_line_chars,
            stored_line_limit: request.max_characters + 2,
            stored_character_limit: request.max_characters + 1,
            window_lines: Vec::new(),
            line_number: 1,
            selected_line_count: 0,
            stored_characters: 0,
            current_line: String::new(),
            current_line_characters: 0,
            current_line_utf16: 0,
            first_selected_line_characters: 0,
            source_offset: 0,
            offset_start_line: None,
            offset_start_column: None,
            normalized_start_offset: None,
            selected_next_line_offset: None,
            hashline_overflow: None,
            pending_cr: false,
        }
    }

    fn resolve_offset_start(&mut self) {
        let Some(requested) = self.start_offset else {
            return;
        };
        if self.offset_start_line.is_some() || self.source_offset < requested {
            return;
        }
        self.offset_start_line = Some(self.line_number);
        self.offset_start_column = Some(self.current_line_characters);
        self.normalized_start_offset = Some(self.source_offset);
    }

    fn is_current_line_selected(&self) -> bool {
        if !self.offset_mode {
            return self.line_number >= self.start_line
                && self.line_number < self.start_line + self.max_lines;
        }
        match self.offset_start_line {
            Some(start) => self.line_number >= start && self.line_number < start + self.max_lines,
            None => false,
        }
    }

    fn finish_line(&mut self, has_newline: bool) {
        self.resolve_offset_start();
        if self.is_current_line_selected() {
            if self.selected_line_count == 0 {
                self.first_selected_line_characters = self.current_line_characters;
            }
            if self.hashline_overflow.is_none()
                && self.current_line_utf16 > self.hashline_max_line_chars
            {
                self.hashline_overflow = Some(HashlineOverflow {
                    line: self.line_number,
                    length: self.current_line_utf16,
                });
            }
            if (self.window_lines.len() as u64) < self.stored_line_limit {
                self.window_lines
                    .push(std::mem::take(&mut self.current_line));
            }
            self.selected_line_count += 1;
            if has_newline {
                self.selected_next_line_offset = Some(self.source_offset + 1);
            }
        }
        self.current_line.clear();
        self.current_line_characters = 0;
        self.current_line_utf16 = 0;
    }

    fn consume_char(&mut self, character: char) {
        if character == '\n' {
            self.finish_line(true);
            self.source_offset += 1;
            self.line_number += 1;
            return;
        }
        self.resolve_offset_start();
        self.current_line_characters += 1;
        self.current_line_utf16 += character.len_utf16() as u64;
        if self.is_current_line_selected()
            && (self.offset_mode
                || self.line_number != self.start_line
                || self.current_line_characters > self.start_column)
            && self.stored_characters < self.stored_character_limit
        {
            self.current_line.push(character);
            self.stored_characters += 1;
        }
        self.source_offset += 1;
    }

    /// Feeds decoded text, turning each CRLF into LF across chunk boundaries.
    fn consume_text(&mut self, text: &str, last: bool) {
        let mut chars = text.chars().peekable();
        if self.pending_cr {
            self.pending_cr = false;
            if chars.peek() != Some(&'\n') {
                self.consume_char('\r');
            }
        }
        while let Some(character) = chars.next() {
            if character == '\r' {
                match chars.peek() {
                    Some('\n') => continue,
                    None if !last => {
                        self.pending_cr = true;
                        continue;
                    }
                    _ => {}
                }
            }
            self.consume_char(character);
        }
    }

    fn finish(mut self, file_hash: String) -> TextScan {
        if self.pending_cr {
            self.pending_cr = false;
            self.consume_char('\r');
        }
        if self.offset_mode && self.offset_start_line.is_none() {
            self.offset_start_line = Some(self.line_number);
            self.offset_start_column = Some(self.current_line_characters);
            self.normalized_start_offset = Some(self.source_offset);
        }
        self.finish_line(false);
        TextScan {
            file_hash,
            window_lines: self.window_lines,
            total_lines: self.line_number,
            selected_line_count: self.selected_line_count,
            first_selected_line_characters: self.first_selected_line_characters,
            offset_start_line: self.offset_start_line,
            offset_start_column: self.offset_start_column,
            normalized_start_offset: self.normalized_start_offset,
            selected_next_line_offset: self.selected_next_line_offset,
            source_offset: self.source_offset,
            hashline_overflow: self.hashline_overflow,
        }
    }
}

/// Decodes UTF-8 incrementally, replacing invalid sequences with U+FFFD like `StringDecoder`.
struct LossyDecoder {
    pending: Vec<u8>,
}

impl LossyDecoder {
    fn decode(&mut self, input: &[u8], out: &mut String) {
        let owned;
        let mut bytes: &[u8] = if self.pending.is_empty() {
            input
        } else {
            self.pending.extend_from_slice(input);
            owned = std::mem::take(&mut self.pending);
            &owned
        };
        loop {
            match std::str::from_utf8(bytes) {
                Ok(text) => {
                    out.push_str(text);
                    return;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    // SAFETY: from_utf8 validated this prefix.
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[..valid]) });
                    match error.error_len() {
                        Some(invalid) => {
                            out.push('\u{FFFD}');
                            bytes = &bytes[valid + invalid..];
                        }
                        None => {
                            // An incomplete sequence at the end may complete in the next chunk.
                            self.pending = bytes[valid..].to_vec();
                            return;
                        }
                    }
                }
            }
        }
    }

    fn finish(&mut self, out: &mut String) {
        if !self.pending.is_empty() {
            out.push_str(&String::from_utf8_lossy(&self.pending));
            self.pending.clear();
        }
    }
}

pub fn scan_text(request: &ScanTextRequest) -> Result<TextScan, FsError> {
    let path = Path::new(&request.path);
    let mut file = File::open(path).map_err(|error| FsError::from_io(&error, "open", path))?;
    let mut scanner = Scanner::new(request);
    let mut hasher = Sha256::new();
    let mut decoder = LossyDecoder {
        pending: Vec::new(),
    };
    let mut buffer = vec![0u8; 256 * 1024];
    let mut text = String::new();
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| FsError::from_read(&error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        text.clear();
        decoder.decode(&buffer[..read], &mut text);
        scanner.consume_text(&text, false);
    }
    text.clear();
    decoder.finish(&mut text);
    scanner.consume_text(&text, true);
    let file_hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(scanner.finish(file_hash))
}
