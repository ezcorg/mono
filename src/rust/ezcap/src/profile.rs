//! The rendering profile: the clause shapes a consent window can show as a
//! sentence.
//!
//! This is deliberately a small recogniser, not a CEL parser. A scope is a
//! conjunction of atoms; each atom is one of a handful of shapes over a dotted
//! path with optional call segments (`request.host()`), a comparison or
//! membership against literals, or a predicate call with literal arguments
//! (`call.args.key.startsWith("seen/")`, `time.is_between_hours(9, 17)`).
//! Anything else is [`Sentence::raw`]: still compiled and enforced by the
//! membrane, shown as CEL with a badge.

use std::fmt;

/// One rendered atom of a scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sentence {
    pub text: String,
    /// `true` when the atom was outside the profile and `text` is raw CEL.
    pub raw: bool,
}

impl Sentence {
    fn plain(text: String) -> Self {
        Sentence { text, raw: false }
    }
    fn raw(text: &str) -> Self {
        Sentence {
            text: text.trim().to_string(),
            raw: true,
        }
    }
}

impl fmt::Display for Sentence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.raw {
            write!(f, "`{}`", self.text)
        } else {
            f.write_str(&self.text)
        }
    }
}

/// Render a scope expression as one sentence per top-level conjunct.
/// `"true"` renders as a single "always" sentence.
pub fn render(expr: &str) -> Vec<Sentence> {
    split_conjunction(expr)
        .into_iter()
        .map(|atom| render_atom(atom).unwrap_or_else(|| Sentence::raw(atom)))
        .collect()
}

/// Join rendered sentences for a denial message or an audit line.
pub fn render_line(expr: &str) -> String {
    render(expr)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Dot,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Plus,
    Bang,
    Op(&'static str),
    In,
}

fn tokenize(src: &str) -> Option<Vec<Tok>> {
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while let Some(&c) = chars.get(i) {
        match c {
            ' ' | '\t' | '\n' | '\r' => i += 1,
            '.' => {
                out.push(Tok::Dot);
                i += 1;
            }
            '(' => {
                out.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1;
            }
            '[' => {
                out.push(Tok::LBracket);
                i += 1;
            }
            ']' => {
                out.push(Tok::RBracket);
                i += 1;
            }
            ',' => {
                out.push(Tok::Comma);
                i += 1;
            }
            '+' => {
                out.push(Tok::Plus);
                i += 1;
            }
            '!' if chars.get(i + 1) != Some(&'=') => {
                out.push(Tok::Bang);
                i += 1;
            }
            '=' | '!' | '<' | '>' => {
                let two: String = chars
                    .get(i..(i + 2).min(chars.len()))
                    .unwrap_or_default()
                    .iter()
                    .collect();
                let op = match two.as_str() {
                    "==" => Some(("==", 2)),
                    "!=" => Some(("!=", 2)),
                    "<=" => Some(("<=", 2)),
                    ">=" => Some((">=", 2)),
                    _ if c == '<' => Some(("<", 1)),
                    _ if c == '>' => Some((">", 1)),
                    _ => None,
                };
                let (op, len) = op?;
                out.push(Tok::Op(op));
                i += len;
            }
            '"' | '\'' => {
                let quote = c;
                i += 1;
                let mut s = String::new();
                loop {
                    let ch = *chars.get(i)?;
                    if ch == '\\' {
                        let next = *chars.get(i + 1)?;
                        s.push(match next {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                        i += 2;
                    } else if ch == quote {
                        i += 1;
                        break;
                    } else {
                        s.push(ch);
                        i += 1;
                    }
                }
                out.push(Tok::Str(s));
            }
            c if c.is_ascii_digit() => {
                let start = i;
                while chars
                    .get(i)
                    .is_some_and(|c| c.is_ascii_digit() || *c == '.')
                {
                    i += 1;
                }
                let text: String = chars.get(start..i).unwrap_or_default().iter().collect();
                if text.contains('.') {
                    out.push(Tok::Float(text.parse().ok()?));
                } else {
                    out.push(Tok::Int(text.parse().ok()?));
                }
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = i;
                while chars
                    .get(i)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
                {
                    i += 1;
                }
                let word: String = chars.get(start..i).unwrap_or_default().iter().collect();
                out.push(match word.as_str() {
                    "true" => Tok::Bool(true),
                    "false" => Tok::Bool(false),
                    "in" => Tok::In,
                    _ => Tok::Ident(word),
                });
            }
            _ => return None,
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Conjunction splitting (top-level `&&` only, respecting parens and strings)
// ---------------------------------------------------------------------------

fn split_conjunction(expr: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let bytes = expr.as_bytes();
    let mut depth = 0i32;
    let mut in_str: Option<u8> = None;
    let mut start = 0;
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        match in_str {
            Some(q) => {
                if b == b'\\' {
                    i += 1;
                } else if b == q {
                    in_str = None;
                }
            }
            None => match b {
                b'"' | b'\'' => in_str = Some(b),
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b'&' if depth == 0 && bytes.get(i + 1) == Some(&b'&') => {
                    parts.push(expr[start..i].trim());
                    i += 2;
                    start = i;
                    continue;
                }
                _ => {}
            },
        }
        i += 1;
    }
    parts.push(expr[start..].trim());
    parts
        .into_iter()
        .map(strip_outer_parens)
        .filter(|p| !p.is_empty())
        .collect()
}

fn strip_outer_parens(mut s: &str) -> &str {
    loop {
        let t = s.trim();
        if t.starts_with('(') && t.ends_with(')') && balanced_outer(t) {
            s = &t[1..t.len() - 1];
        } else {
            return t;
        }
    }
}

fn balanced_outer(t: &str) -> bool {
    let mut depth = 0i32;
    for (i, b) in t.bytes().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 && i != t.len() - 1 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

// ---------------------------------------------------------------------------
// Atom parsing
// ---------------------------------------------------------------------------

/// A dotted path where each segment may be a zero-argument call:
/// `call.args.key`, `request.host()`.
#[derive(Debug, Clone, PartialEq)]
struct Path {
    segments: Vec<(String, bool)>,
}

#[derive(Debug, Clone, PartialEq)]
enum Lit {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq)]
enum Operand {
    Path(Path),
    Lit(Lit),
    Sum(Vec<Operand>),
}

#[derive(Debug, Clone, PartialEq)]
enum Atom {
    True,
    Cmp {
        lhs: Operand,
        op: &'static str,
        rhs: Lit,
    },
    In {
        lhs: Operand,
        items: Vec<Lit>,
    },
    /// `path.method(args)` where the last segment is the predicate.
    Pred {
        path: Path,
        method: String,
        args: Vec<Lit>,
    },
    Not(Box<Atom>),
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }
    fn next(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        self.pos += 1;
        t
    }
    fn eat(&mut self, t: &Tok) -> bool {
        if self.peek() == Some(t) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn done(&self) -> bool {
        self.pos >= self.toks.len()
    }

    fn atom(&mut self) -> Option<Atom> {
        if self.eat(&Tok::Bang) {
            return Some(Atom::Not(Box::new(self.atom()?)));
        }
        if self.eat(&Tok::LParen) {
            let inner = self.atom()?;
            if !self.eat(&Tok::RParen) {
                return None;
            }
            return Some(inner);
        }
        if let Some(Tok::Bool(true)) = self.peek()
            && self.toks.len() == self.pos + 1
        {
            self.pos += 1;
            return Some(Atom::True);
        }
        let lhs = self.operand()?;
        match self.peek() {
            Some(Tok::Op(op)) => {
                let op = *op;
                self.pos += 1;
                let rhs = self.literal()?;
                Some(Atom::Cmp { lhs, op, rhs })
            }
            Some(Tok::In) => {
                self.pos += 1;
                if !self.eat(&Tok::LBracket) {
                    return None;
                }
                let mut items = Vec::new();
                loop {
                    if self.eat(&Tok::RBracket) {
                        break;
                    }
                    items.push(self.literal()?);
                    if self.eat(&Tok::Comma) {
                        continue;
                    }
                    if !self.eat(&Tok::RBracket) {
                        return None;
                    }
                    break;
                }
                Some(Atom::In { lhs, items })
            }
            None => match lhs {
                // A bare predicate call: `path.method(args)` parsed as an operand
                // whose last segment carried arguments.
                Operand::Path(p) => self.pred_from_path(p),
                _ => None,
            },
            _ => None,
        }
    }

    /// Re-interpret a path whose final call segment had arguments (stored as
    /// a pending predicate) — see `path_or_pred`.
    fn pred_from_path(&mut self, _p: Path) -> Option<Atom> {
        None
    }

    fn operand(&mut self) -> Option<Operand> {
        let first = self.term()?;
        if self.peek() == Some(&Tok::Plus) {
            let mut terms = vec![first];
            while self.eat(&Tok::Plus) {
                terms.push(self.term()?);
            }
            return Some(Operand::Sum(terms));
        }
        Some(first)
    }

    fn term(&mut self) -> Option<Operand> {
        match self.peek()? {
            Tok::Ident(_) => Some(Operand::Path(self.path_no_args()?)),
            _ => Some(Operand::Lit(self.literal()?)),
        }
    }

    /// A path whose call segments take no arguments.
    fn path_no_args(&mut self) -> Option<Path> {
        let mut segments = Vec::new();
        loop {
            let name = match self.next()? {
                Tok::Ident(s) => s,
                _ => return None,
            };
            let mut call = false;
            if self.peek() == Some(&Tok::LParen) {
                if self.toks.get(self.pos + 1) == Some(&Tok::RParen) {
                    self.pos += 2;
                    call = true;
                } else {
                    // A call with arguments: this is a predicate, not a path.
                    self.pos -= 1;
                    return None;
                }
            }
            segments.push((name, call));
            if !self.eat(&Tok::Dot) {
                break;
            }
        }
        Some(Path { segments })
    }

    fn literal(&mut self) -> Option<Lit> {
        match self.next()? {
            Tok::Str(s) => Some(Lit::Str(s)),
            Tok::Int(i) => Some(Lit::Int(i)),
            Tok::Float(f) => Some(Lit::Float(f)),
            Tok::Bool(b) => Some(Lit::Bool(b)),
            _ => None,
        }
    }

    /// `path.method(lit, lit, …)`: the whole token stream is one predicate.
    fn predicate(&mut self) -> Option<Atom> {
        let negated = self.eat(&Tok::Bang);
        let mut segments: Vec<(String, bool)> = Vec::new();
        loop {
            let name = match self.next()? {
                Tok::Ident(s) => s,
                _ => return None,
            };
            if self.eat(&Tok::LParen) {
                if self.eat(&Tok::RParen) {
                    segments.push((name, true));
                } else {
                    let mut args = Vec::new();
                    loop {
                        args.push(self.literal()?);
                        if self.eat(&Tok::Comma) {
                            continue;
                        }
                        if !self.eat(&Tok::RParen) {
                            return None;
                        }
                        break;
                    }
                    if !self.done() {
                        return None;
                    }
                    let atom = Atom::Pred {
                        path: Path { segments },
                        method: name,
                        args,
                    };
                    return Some(if negated {
                        Atom::Not(Box::new(atom))
                    } else {
                        atom
                    });
                }
            } else {
                segments.push((name, false));
            }
            if !self.eat(&Tok::Dot) {
                return None;
            }
        }
    }
}

fn parse_atom(src: &str) -> Option<Atom> {
    let toks = tokenize(src)?;
    // Try the comparison / membership grammar first, then a predicate call.
    let mut p = Parser {
        toks: toks.clone(),
        pos: 0,
    };
    if let Some(atom) = p.atom()
        && p.done()
    {
        return Some(atom);
    }
    let mut p = Parser { toks, pos: 0 };
    p.predicate()
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn render_atom(src: &str) -> Option<Sentence> {
    let atom = parse_atom(src)?;
    render_parsed(&atom).map(Sentence::plain)
}

fn render_parsed(atom: &Atom) -> Option<String> {
    Some(match atom {
        Atom::True => "always".to_string(),
        Atom::Not(inner) => format!("not ({})", render_parsed(inner)?),
        Atom::Cmp { lhs, op, rhs } => {
            let subject = render_operand(lhs);
            let value = render_lit(rhs);
            match *op {
                "==" => format!("{subject} is {value}"),
                "!=" => format!("{subject} is not {value}"),
                "<" => format!("{subject} is below {value}"),
                "<=" => format!("{subject} is at most {value}"),
                ">" => format!("{subject} is above {value}"),
                ">=" => format!("{subject} is at least {value}"),
                _ => return None,
            }
        }
        Atom::In { lhs, items } => {
            let subject = render_operand(lhs);
            let list = items.iter().map(render_lit).collect::<Vec<_>>();
            format!("{subject} is one of {}", join_or(&list))
        }
        Atom::Pred { path, method, args } => render_pred(path, method, args)?,
    })
}

fn render_pred(path: &Path, method: &str, args: &[Lit]) -> Option<String> {
    let subject = render_path(path);
    let a = |i: usize| args.get(i).map(render_lit);
    Some(
        match (path.segments.first().map(|s| s.0.as_str()), method) {
            (Some("time"), "is_between_hours") => {
                let (from, to) = (hour(args.first())?, hour(args.get(1))?);
                format!("between {from} and {to} local time")
            }
            (Some("time"), "is_day_of_week") => {
                let days = args.iter().map(render_lit).collect::<Vec<_>>();
                format!("on {}", join_or(&days))
            }
            (Some("time"), "matches_cron") => format!("when the schedule {} matches", a(0)?),
            (_, "startsWith") => format!("{subject} starts with {}", a(0)?),
            (_, "endsWith") => format!("{subject} ends with {}", a(0)?),
            (_, "contains") => format!("{subject} contains {}", a(0)?),
            (_, "matches") => format!("{subject} matches the pattern {}", a(0)?),
            (_, "exists") | (_, "has") => return None,
            _ => return None,
        },
    )
}

fn hour(lit: Option<&Lit>) -> Option<String> {
    match lit? {
        Lit::Int(h) => Some(format!("{h:02}:00")),
        _ => None,
    }
}

fn render_operand(op: &Operand) -> String {
    match op {
        Operand::Path(p) => render_path(p),
        Operand::Lit(l) => render_lit(l),
        Operand::Sum(terms) => terms
            .iter()
            .map(render_operand)
            .collect::<Vec<_>>()
            .join(" plus "),
    }
}

/// Humanise a dotted path: known prefixes become phrases, `_` becomes space,
/// a trailing `()` is dropped.
fn render_path(p: &Path) -> String {
    let names: Vec<&str> = p.segments.iter().map(|(n, _)| n.as_str()).collect();
    let rest = |from: usize| {
        names
            .get(from..)
            .unwrap_or_default()
            .join(" ")
            .replace('_', " ")
    };
    match names.as_slice() {
        ["call", "method"] => "the method".to_string(),
        ["call", "bytes"] => "the call's size".to_string(),
        ["call", "args", ..] => rest(2),
        ["caller", "plugin"] => "the calling plugin".to_string(),
        ["caller", "key"] => "the caller's key".to_string(),
        ["caller", "peer"] => "the calling peer".to_string(),
        ["caller", "origin"] => "the caller's origin".to_string(),
        ["state", "calls"] => "calls so far".to_string(),
        ["state", "bytes"] => "bytes so far".to_string(),
        ["state", name] => format!("{} so far", name.replace('_', " ")),
        ["request", ..] => format!("the request {}", rest(1)),
        ["response", ..] => format!("the response {}", rest(1)),
        ["content", ..] => format!("the content {}", rest(1)),
        ["connect", ..] => format!("the connection {}", rest(1)),
        _ => rest(0),
    }
}

fn render_lit(l: &Lit) -> String {
    match l {
        Lit::Str(s) => format!("“{s}”"),
        Lit::Int(i) => i.to_string(),
        Lit::Float(f) => f.to_string(),
        Lit::Bool(b) => b.to_string(),
    }
}

fn join_or(items: &[String]) -> String {
    match items {
        [] => "nothing".to_string(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} or {}", init.join(", "), last),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(expr: &str) -> Sentence {
        let v = render(expr);
        assert_eq!(v.len(), 1, "{expr:?} -> {v:?}");
        v.into_iter().next().unwrap_or(Sentence::raw(""))
    }

    #[test]
    fn renders_profile_shapes() {
        assert_eq!(one("true").text, "always");
        assert_eq!(
            one(r#"call.args.key.startsWith("seen/")"#).text,
            "key starts with “seen/”"
        );
        assert_eq!(one(r#"call.method == "set""#).text, "the method is “set”");
        assert_eq!(
            one(r#"call.args.model in ["haiku", "sonnet"]"#).text,
            "model is one of “haiku” or “sonnet”"
        );
        assert_eq!(
            one("state.tokens + call.args.max_tokens <= 50000").text,
            "tokens so far plus max tokens is at most 50000"
        );
        assert_eq!(
            one("time.is_between_hours(9, 17)").text,
            "between 09:00 and 17:00 local time"
        );
        assert_eq!(
            one(r#"request.host() == "youtube.com""#).text,
            "the request host is “youtube.com”"
        );
        assert_eq!(
            one(r#"!call.args.path.contains("..")"#).text,
            "not (path contains “..”)"
        );
        assert_eq!(one("state.calls < 100").text, "calls so far is below 100");
    }

    #[test]
    fn splits_conjunctions_and_falls_back_to_raw() {
        let v = render(r#"(call.args.key.startsWith("seen/")) && (time.is_between_hours(9, 17))"#);
        assert_eq!(v.len(), 2);
        assert!(!v[0].raw && !v[1].raw);

        let v = render(r#"call.args.key.startsWith("a") && size(call.args.key) < 20"#);
        assert_eq!(v.len(), 2);
        assert!(!v[0].raw);
        assert!(v[1].raw);
        assert_eq!(v[1].text, "size(call.args.key) < 20");

        let v = render(r#"request.host() != 'x' || request.path() == '/'"#);
        assert_eq!(v.len(), 1);
        assert!(v[0].raw);
    }
}
