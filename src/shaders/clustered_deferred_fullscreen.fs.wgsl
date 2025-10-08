// Clustered Deferred - Fullscreen fragment shader

const clusterCountX = ${clusterCountX};
const clusterCountY = ${clusterCountY};
const clusterCountZ = ${clusterCountZ};
const maxLightsPerCluster = ${maxLightsPerCluster};

@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterLights: array<u32>;

@group(1) @binding(0) var gPosition: texture_2d<f32>;
@group(1) @binding(1) var gNormal: texture_2d<f32>;
@group(1) @binding(2) var gAlbedo: texture_2d<f32>;
@group(1) @binding(3) var gSampler: sampler;

struct FSIn {
    @location(0) uv: vec2f,
    @builtin(position) fragCoord: vec4f
}

fn computeClusterIndex(fragCoord: vec2f, viewPosZ: f32) -> u32 {
    // compute tile x/y from screen pixels
    let screen = cameraUniforms.screenSize;
    let tileSizeX = screen.x / f32(clusterCountX);
    let tileSizeY = screen.y / f32(clusterCountY);
    let cx = clamp(u32(fragCoord.x / tileSizeX), 0u, clusterCountX - 1u);
    let cy_unflipped = clamp(u32(fragCoord.y / tileSizeY), 0u, clusterCountY - 1u);
    let cy = (clusterCountY - 1u) - cy_unflipped;

    let near = cameraUniforms.nearPlane;
    let far = cameraUniforms.farPlane;
    let z = -viewPosZ; // positive distance from camera
    let zClamped = max(z, near);
    let logRatio = log(far / near);
    let zSliceF = floor(f32(clusterCountZ) * log(zClamped / near) / logRatio);
    let cz = clamp(u32(zSliceF), 0u, clusterCountZ - 1u);

    return cx + cy * clusterCountX + cz * clusterCountX * clusterCountY;
}

@fragment
fn main(in: FSIn) -> @location(0) vec4f {
    let posWorld = textureSample(gPosition, gSampler, in.uv).xyz;
    let norWorld = normalize(textureSample(gNormal, gSampler, in.uv).xyz);
    let albedo = textureSample(gAlbedo, gSampler, in.uv).rgb;

    // Early out if background (no geometry wrote here)
    // Heuristic: if normal length is ~0, treat as empty
    if (length(norWorld) < 1e-3) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }

    let viewPosZ = (cameraUniforms.viewMat * vec4f(posWorld, 1.0)).z;
    let clusterIdx = computeClusterIndex(in.fragCoord.xy, viewPosZ);
    let base = clusterIdx * (1u + maxLightsPerCluster);
    let num = clusterLights[base];

    var totalLightContrib = vec3f(0, 0, 0);
    for (var i = 0u; i < num; i++) {
        let lightIdx = clusterLights[base + 1u + i];
        let light = lightSet.lights[lightIdx];
        totalLightContrib += calculateLightContrib(light, posWorld, norWorld);
    }

    let finalColor = albedo * totalLightContrib;
    return vec4f(finalColor, 1);
}
