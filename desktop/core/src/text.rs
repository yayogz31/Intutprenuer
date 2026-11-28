//! Limpieza del texto de Whisper (igual que en la página: anotaciones de sonido, frases inventadas,
//! repeticiones) y armado del `initial_prompt`.

use regex::Regex;
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("regex válida"))
}

/// Frases que Whisper inventa con ruido o silencio.
pub fn is_hallucination(t: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = re(&R, r"(?i)(gracias por ver|suscr[ií]bete|subt[ií]tulos|amara\.org|thank you for watching|thanks for watching|please subscribe|like and subscribe|www\.|\.com\b)");
    r.is_match(t)
}

/// El mismo grupo de 3 palabras repetido 4+ veces.
pub fn is_repetitive(t: &str) -> bool {
    let w: Vec<String> = t.to_lowercase().split_whitespace().map(|s| s.to_string()).collect();
    if w.len() < 12 {
        return false;
    }
    let mut seen = std::collections::HashMap::new();
    for i in 0..=w.len() - 3 {
        *seen.entry(w[i..i + 3].join(" ")).or_insert(0) += 1;
    }
    seen.values().copied().max().unwrap_or(0) >= 4
}

pub fn clean(raw: &str) -> String {
    static ANN: OnceLock<Regex> = OnceLock::new();
    static ORD: OnceLock<Regex> = OnceLock::new();
    static ORD2: OnceLock<Regex> = OnceLock::new();
    static SP: OnceLock<Regex> = OnceLock::new();
    let mut t = raw.replace(['\n', '\r'], " ");
    // "(Susurro)", "[Music]", "(risas)", "*tos*"
    t = re(&ANN, r"\s*(\[[^\]]{1,25}\]|\([^)]{1,25}\)|\*[^*]{1,25}\*|♪+)\s*").replace_all(&t, " ").into_owned();
    // "6th, 7th, 8th" → "6 7 8" (listas de dígitos escritas como ordinales)
    let ord2 = re(&ORD2, r"(?i)(st|nd|rd|th)");
    t = re(&ORD, r"(?i)\b\d{1,2}(?:st|nd|rd|th)(?:,?\s+\d{1,2}(?:st|nd|rd|th))+\b")
        .replace_all(&t, |c: &regex::Captures| ord2.replace_all(&c[0], "").replace(',', ""))
        .into_owned();
    // "...1... ...2..." (relleno inventado)
    static DOTS: OnceLock<Regex> = OnceLock::new();
    t = re(&DOTS, r"(\s*\.{3}\S{0,3}\.{3})+").replace_all(&t, "…").into_owned();
    t = dedupe_words(&t);
    t = cut_loops(&t);
    t = re(&SP, r"\s+").replace_all(&t, " ").trim().to_string();
    // "- " al inicio y "..." sueltos que Whisper agrega a veces
    t = t.trim_start_matches(['-', '–', '—', ' ']).to_string();
    if is_hallucination(&t) || is_repetitive(&t) {
        return String::new();
    }
    t
}

/// Whisper a veces repite la misma frase en bucle: se conserva la primera vez y se corta el resto.
pub fn cut_loops(t: &str) -> String {
    let toks: Vec<&str> = t.split_whitespace().collect();
    let norm: Vec<String> = toks.iter().map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()).collect();
    let n = 4;
    if toks.len() < n * 2 {
        return t.to_string();
    }
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for i in 0..=norm.len() - n {
        let k = norm[i..i + n].join(" ");
        if k.chars().filter(|c| c.is_alphabetic()).count() < 6 {
            continue; // grupos de dígitos o palabras muy cortas sí se repiten de verdad
        }
        if let Some(&first) = seen.get(&k) {
            if i >= first + n {
                return toks[..i].join(" ").trim_end_matches([',', ' ']).to_string();
            }
        } else {
            seen.insert(k, i);
        }
    }
    t.to_string()
}

/// "otro, otro, otro" → "otro" (3 o más repeticiones seguidas de la misma palabra).
fn dedupe_words(t: &str) -> String {
    let toks: Vec<&str> = t.split_whitespace().collect();
    let norm = |s: &str| s.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'').to_lowercase();
    let mut out: Vec<&str> = Vec::with_capacity(toks.len());
    let mut i = 0;
    while i < toks.len() {
        let w = norm(toks[i]);
        let mut j = i + 1;
        while j < toks.len() && !w.is_empty() && norm(toks[j]) == w && !w.chars().all(|c| c.is_ascii_digit()) {
            j += 1;
        }
        if j - i >= 3 {
            out.push(toks[j - 1]);
        } else {
            out.extend_from_slice(&toks[i..j]);
        }
        i = j;
    }
    out.join(" ")
}

/// ¿El texto es solo una copia del prompt de contexto? (alucinación típica con `initial_prompt`)
pub fn echoes_prompt(text: &str, prompt: &str) -> bool {
    if prompt.is_empty() || text.len() < 12 {
        return false;
    }
    let n = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>();
    let (t, p) = (n(text), n(prompt));
    p.contains(t.trim())
}

/// `initial_prompt` para el modelo preciso: términos de la llamada y las últimas frases del mismo idioma.
/// Whisper acepta ~224 tokens; se deja en ~600 caracteres para no frenar ni sesgar demasiado.
pub fn build_prompt(lang: &str, terms: &[String], recent: &[(String, String)]) -> String {
    let mut p = String::new();
    let mut tl: Vec<&str> = Vec::new();
    let mut len = 0;
    for t in terms {
        if len + t.len() > 260 {
            break;
        }
        len += t.len() + 2;
        tl.push(t);
    }
    if !tl.is_empty() {
        p.push_str(&tl.join(", "));
        p.push_str(". ");
    }
    let mut prev: Vec<&str> = recent.iter().rev().filter(|(l, _)| l == lang).map(|(_, t)| t.as_str()).take(2).collect();
    prev.reverse();
    let mut tail = prev.join(" ");
    if tail.len() > 320 {
        let cut = tail.len() - 320;
        let cut = (cut..tail.len()).find(|&i| tail.is_char_boundary(i)).unwrap_or(0);
        tail = tail[cut..].to_string();
    }
    p.push_str(&tail);
    p.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limpia() {
        assert_eq!(clean(" [Music] Hello there. "), "Hello there.");
        assert_eq!(clean("Gracias por ver el video"), "");
        assert_eq!(clean("the 6th, 7th, 8th"), "the 6 7 8");
        assert_eq!(clean("no no no no"), "no");
        assert_eq!(clean("4 4 4 4"), "4 4 4 4");
        assert_eq!(clean("Hello, my name is John Smith. My name is John Smith. My name is John"), "Hello, my name is John Smith.");
    }
    #[test]
    fn prompt() {
        let p = build_prompt("en", &["claim".into(), "adjuster".into()], &[("en".into(), "I had an accident.".into()), ("es".into(), "Hola".into())]);
        assert_eq!(p, "claim, adjuster. I had an accident.");
        assert!(echoes_prompt("claim, adjuster.", &p));
    }
}
