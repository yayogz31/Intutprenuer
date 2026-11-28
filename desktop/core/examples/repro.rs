use inturp_core::asr::{Model, Options};
fn main() {
    let a = inturp_core::audio::read_wav_16k(std::path::Path::new("../tests/audio/en_seguros.wav")).unwrap();
    let m = std::env::args().nth(1).unwrap();
    let short = std::env::args().nth(2).map(|s| s == "short").unwrap_or(false);
    let mut model = Model::load(std::path::Path::new(&m), false, 4, "x").unwrap();
    for (s, e) in [(0.5, 6.0), (6.0, 14.0), (14.0, 17.0), (0.5, 3.0)] {
        let seg = &a[(s * 16000.0) as usize..(e * 16000.0) as usize];
        let r = model.transcribe(seg, &Options { lang: "en", prompt: "claim, adjuster.", short_ctx: short, beam: false, abort: None });
        println!("{s}-{e}: {:?}", r.map(|t| t.text));
    }
}
