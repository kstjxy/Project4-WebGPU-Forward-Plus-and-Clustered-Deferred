// Forward+ fragment shader using clustered lights

const clusterCountX = ${clusterCountX};
const clusterCountY = ${clusterCountY};
const clusterCountZ = ${clusterCountZ};
const maxLightsPerCluster = ${maxLightsPerCluster};

@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterLights: array<u32>;

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput
{
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f,
    @builtin(position) fragCoord: vec4f
}

fn computeClusterIndex(fragCoord: vec2f, viewPosZ: f32) -> u32 {
    // compute tile x/y from screen pixels
    let screen = cameraUniforms.screenSize;
    let tileSizeX = screen.x / f32(clusterCountX);
    let tileSizeY = screen.y / f32(clusterCountY);
    let cx = clamp(u32(fragCoord.x / tileSizeX), 0u, clusterCountX - 1u);
    // Flip Y so that 0 is bottom (NDC -1) and clusterCountY-1 is top (NDC +1)
    let cy_unflipped = clamp(u32(fragCoord.y / tileSizeY), 0u, clusterCountY - 1u);
    let cy = (clusterCountY - 1u) - cy_unflipped;

    // compute z slice using logarithmic splitting in view space
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
fn main(in: FragmentInput) -> @location(0) vec4f
{
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    // view-space z for clustering
    let viewPosZ = (cameraUniforms.viewMat * vec4f(in.pos, 1.0)).z;
    let clusterIdx = computeClusterIndex(in.fragCoord.xy, viewPosZ);
    let base = clusterIdx * (1u + maxLightsPerCluster);
    let num = clusterLights[base];

    var totalLightContrib = vec3f(0, 0, 0);
    let N = normalize(in.nor);
    for (var i = 0u; i < num; i++) {
        let lightIdx = clusterLights[base + 1u + i];
        let light = lightSet.lights[lightIdx];
        totalLightContrib += calculateLightContrib(light, in.pos, N);
    }

    var finalColor = diffuseColor.rgb * totalLightContrib;
    return vec4f(finalColor, 1);
}
