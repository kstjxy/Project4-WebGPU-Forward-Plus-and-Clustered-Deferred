// Light clustering compute shader (Forward+)

const clusterCountX = ${clusterCountX};
const clusterCountY = ${clusterCountY};
const clusterCountZ = ${clusterCountZ};
const numClusters = clusterCountX * clusterCountY * clusterCountZ;
const maxLightsPerCluster = ${maxLightsPerCluster};

@group(${bindGroup_scene}) @binding(0) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(1) var<uniform> cameraUniforms: CameraUniforms;
// Flattened storage: for each cluster, first u32 is count, followed by indices (u32)
@group(${bindGroup_scene}) @binding(2) var<storage, read_write> clusterLights: array<u32>;

fn isSphereIntersectingAABB(center: vec3f, radius: f32, aabbMin: vec3f, aabbMax: vec3f) -> bool {
    let closestPoint = clamp(center, aabbMin, aabbMax);
    let d = length(center - closestPoint);
    return d <= radius;
}

@compute
@workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= clusterCountX || gid.y >= clusterCountY || gid.z >= clusterCountZ) {
        return;
    }

    let clusterIdx = gid.x + gid.y * clusterCountX + gid.z * clusterCountX * clusterCountY;
    let base = clusterIdx * (1u + maxLightsPerCluster);
    // reset count
    clusterLights[base] = 0u;

    // Compute XY bounds in NDC for this cluster ([-1, 1])
    let sliceNDCX = 2.0 / f32(clusterCountX);
    let sliceNDCY = 2.0 / f32(clusterCountY);
    let xMin = -1.0 + f32(gid.x) * sliceNDCX;
    let xMax = -1.0 + f32(gid.x + 1u) * sliceNDCX;
    let yMin = -1.0 + f32(gid.y) * sliceNDCY;
    let yMax = -1.0 + f32(gid.y + 1u) * sliceNDCY;

    // Logarithmic Z slicing in view space
    let near = cameraUniforms.nearPlane;
    let far = cameraUniforms.farPlane;
    let logRatio = log(far / near);
    let zViewMin = -near * exp(logRatio * f32(gid.z) / f32(clusterCountZ));
    let zViewMax = -near * exp(logRatio * f32(gid.z + 1u) / f32(clusterCountZ));

    // Convert Z bounds to NDC for corner reconstruction
    let P = cameraUniforms.projMat;
    let zNDCMin = ((P[2][2] * zViewMin) + P[3][2]) / ((P[2][3] * zViewMin) + P[3][3]);
    let zNDCMax = ((P[2][2] * zViewMax) + P[3][2]) / ((P[2][3] * zViewMax) + P[3][3]);

    // Reconstruct 8 frustum corners of this cluster in view space
    let invP = cameraUniforms.invProjMat;
    var ndcCorners = array<vec4f, 8>(
        vec4f(xMin, yMin, zNDCMin, 1.0),
        vec4f(xMax, yMin, zNDCMin, 1.0),
        vec4f(xMin, yMax, zNDCMin, 1.0),
        vec4f(xMax, yMax, zNDCMin, 1.0),
        vec4f(xMin, yMin, zNDCMax, 1.0),
        vec4f(xMax, yMin, zNDCMax, 1.0),
        vec4f(xMin, yMax, zNDCMax, 1.0),
        vec4f(xMax, yMax, zNDCMax, 1.0)
    );
    var vsCorners: array<vec3f, 8>;
    for (var i = 0u; i < 8u; i++) {
        var c = invP * ndcCorners[i];
        c = c / c.w;
        vsCorners[i] = c.xyz;
    }

    // Compute AABB in view space
    var aabbMin = vsCorners[0];
    var aabbMax = vsCorners[0];
    for (var i = 1u; i < 8u; i++) {
        aabbMin = min(aabbMin, vsCorners[i]);
        aabbMax = max(aabbMax, vsCorners[i]);
    }

    // Assign lights that intersect this cluster
    let radius = f32(${lightRadius});
    let V = cameraUniforms.viewMat;
    var count = 0u;
    for (var li = 0u; li < lightSet.numLights; li++) {
        let lp_view = (V * vec4f(lightSet.lights[li].pos, 1.0)).xyz;
        // Quick AABB overlap using sphere AABB
        let sMin = lp_view - vec3f(radius);
        let sMax = lp_view + vec3f(radius);
        let intersectMin = max(aabbMin, sMin);
        let intersectMax = min(aabbMax, sMax);
        let overlaps = all(intersectMin <= intersectMax);
        if (overlaps) {
            if (count < maxLightsPerCluster) {
                clusterLights[base + 1u + count] = li;
                count++;
                clusterLights[base] = count;
            } else {
                // cluster is full; stop early
                break;
            }
        }
    }
}

