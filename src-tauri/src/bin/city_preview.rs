//! `city_preview <repo-path> <out.html>` — builds a `CityModel`, lays it out
//! via the persisted `layout_city_persisted_from_root` (never the
//! reshuffling, tests-only `layout_city`), renders the result to SVG via
//! `city::preview::preview_svg`, and writes a standalone HTML file so the
//! result can be opened in a browser or screenshotted by headless Chrome
//! (which needs no attached display) — see `city::preview` for why that
//! matters.

use std::path::Path;

use tauri_app_lib::city::layout::layout_city_persisted_from_root;
use tauri_app_lib::city::model::{CityModel, CitySource, RealFiles, RealGitFiles};
use tauri_app_lib::city::preview::{
    kind_color, kind_label, label_suppression_notice, preview_svg, source_notice,
    submodule_notice, KIND_ORDER,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (repo, out) = match args.as_slice() {
        [_, repo, out] => (repo.clone(), out.clone()),
        _ => {
            eprintln!("usage: city_preview <repo-path> <out.html>");
            std::process::exit(1);
        }
    };

    let root = Path::new(&repo);
    let (model, layout) =
        layout_city_persisted_from_root(root, &RealFiles::new(Box::new(RealGitFiles::default())));
    let svg = preview_svg(&model, &layout);
    let building_count: usize = model.districts.iter().map(|d| d.buildings.len()).sum();

    // All three are caption-only notices (label suppression, excluded
    // submodules, a degraded git-unavailable render) — none changes what
    // gets drawn.
    let notices: Vec<String> = [
        label_suppression_notice(&model),
        submodule_notice(&model),
        source_notice(&model),
    ]
    .into_iter()
    .flatten()
    .collect();

    let html = render_html(&model, &svg, building_count, notices);
    if let Err(e) = std::fs::write(&out, html) {
        eprintln!("failed to write {out}: {e}");
        std::process::exit(1);
    }

    let source_label = match model.source {
        CitySource::Git => "git",
        CitySource::Walk => "walk (degraded)",
    };
    println!(
        "{}: {} districts, {building_count} buildings, {} skipped, {} submodules, source={source_label} -> {out}",
        model.name,
        model.districts.len(),
        model.skipped,
        model.submodules,
    );
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn render_html(model: &CityModel, svg: &str, building_count: usize, notices: Vec<String>) -> String {
    // Each notice (label suppression, excluded submodules, ...) gets its
    // own " · " segment — a large city that legitimately has every tiny
    // plot unlabelled, or one that honestly excluded a submodule, must
    // not look identical to a render that silently lost something.
    let notice_html: String =
        notices.iter().map(|n| format!(" &middot; {}", escape_html(n))).collect();
    let legend: String = KIND_ORDER
        .iter()
        .map(|kind| {
            format!(
                "<span class=\"legend-item\"><span class=\"swatch\" style=\"background:{}\"></span>{}</span>",
                kind_color(*kind),
                kind_label(*kind),
            )
        })
        .collect::<Vec<_>>()
        .join("\n      ");

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>{repo_name} — city preview</title>
<style>
  :root {{ color-scheme: light dark; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    padding: 28px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: #faf6ee;
    color: #4a4438;
  }}
  h1 {{ font-size: 19px; font-weight: 600; margin: 0 0 4px; }}
  .caption {{ font-size: 13px; color: #8a8070; margin-bottom: 16px; }}
  .legend {{
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-bottom: 18px;
    font-size: 12px;
    color: #6b6354;
  }}
  .legend-item {{ display: inline-flex; align-items: center; gap: 6px; }}
  .swatch {{
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 3px;
  }}
  .stage {{
    background: #fffdf8;
    border-radius: 14px;
    padding: 14px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    overflow: auto;
    display: inline-block;
  }}
  svg {{ display: block; }}
</style>
</head>
<body>
  <h1>{repo_name}</h1>
  <div class="caption">{district_count} districts &middot; {building_count} buildings &middot; {skipped} skipped{notice_html}</div>
  <div class="legend">
      {legend}
  </div>
  <div class="stage">
{svg}  </div>
</body>
</html>
"#,
        repo_name = escape_html(&model.name),
        district_count = model.districts.len(),
        skipped = model.skipped,
    )
}
