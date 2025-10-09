struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f
}

@vertex
fn main(@builtin(vertex_index) vid: u32) -> VSOut {
    let positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f( 3.0, -1.0),
        vec2f(-1.0,  3.0)
    );
    let p = positions[vid];
    var out: VSOut;
    out.pos = vec4f(p, 0.0, 1.0);
    out.uv = vec2f(p.x, -p.y) * 0.5 + vec2f(0.5, 0.5);
    return out;
}

