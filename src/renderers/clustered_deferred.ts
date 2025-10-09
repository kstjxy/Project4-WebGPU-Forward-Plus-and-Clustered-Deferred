import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export class ClusteredDeferredRenderer extends renderer.Renderer {
    // Scene uniforms and pipelines
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;

    // G-buffer textures
    gPositionTex: GPUTexture; gPositionView: GPUTextureView;
    gNormalTex: GPUTexture; gNormalView: GPUTextureView;
    gAlbedoTex: GPUTexture; gAlbedoView: GPUTextureView;
    gbufferSampler: GPUSampler;

    depthTexture: GPUTexture; depthTextureView: GPUTextureView;
    sceneColorTex: GPUTexture; sceneColorView: GPUTextureView;

    gbufferPipeline: GPURenderPipeline;
    fullscreenBindGroupLayout: GPUBindGroupLayout;
    fullscreenBindGroup: GPUBindGroup;
    fullscreenPipeline: GPURenderPipeline;

    // post-processing (toon)
    ppOutputTex: GPUTexture; ppOutputView: GPUTextureView;
    ppComputeBGL: GPUBindGroupLayout; ppComputeBG: GPUBindGroup;
    ppComputePipeline: GPUComputePipeline; ppUniformsBuffer: GPUBuffer;
    copyBGL: GPUBindGroupLayout; copyFromToonBG: GPUBindGroup; copyFromSceneBG: GPUBindGroup; copyPipeline: GPURenderPipeline;

    // toon settings
    private toonEnabled: boolean = false;
    private toonLevels: number = 4;
    private toonThreshold: number = 0.0025;

    constructor(stage: Stage) {
        super(stage);

        // Scene uniforms (camera + lights + clusters)
        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "clustered deferred scene BGL",
            entries: [
                { // camera uniforms
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                { // light set
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                },
                { // cluster lights
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                }
            ]
        });

        this.sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: "clustered deferred scene BG",
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.lights.clusterLightsStorageBuffer } }
            ]
        });

        // G-buffer textures
        const size: GPUExtent3D = [renderer.canvas.width, renderer.canvas.height];
        this.gPositionTex = renderer.device.createTexture({
            label: "gbuf position",
            size, format: "rgba16float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.gPositionView = this.gPositionTex.createView();
        this.gNormalTex = renderer.device.createTexture({
            label: "gbuf normal",
            size, format: "rgba16float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.gNormalView = this.gNormalTex.createView();
        this.gAlbedoTex = renderer.device.createTexture({
            label: "gbuf albedo",
            size, format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.gAlbedoView = this.gAlbedoTex.createView();

        this.gbufferSampler = renderer.device.createSampler({
            label: "gbuffer sampler",
            magFilter: "nearest",
            minFilter: "nearest"
        });

        this.depthTexture = renderer.device.createTexture({
            size, format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.depthTextureView = this.depthTexture.createView();

        // color target for fullscreen lighting (offscreen)
        this.sceneColorTex = renderer.device.createTexture({
            label: 'clustered deferred color',
            size,
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.sceneColorView = this.sceneColorTex.createView();

        // G-buffer pipeline (geometry pass)
        this.gbufferPipeline = renderer.device.createRenderPipeline({
            layout: renderer.device.createPipelineLayout({
                label: "gbuffer pipeline layout",
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout
                ]
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus"
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "gbuffer vert shader",
                    code: shaders.naiveVertSrc
                }),
                buffers: [ renderer.vertexBufferLayout ]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "gbuffer frag shader",
                    code: shaders.clusteredDeferredFragSrc
                }),
                targets: [
                    { format: "rgba16float" },
                    { format: "rgba16float" },
                    { format: "rgba8unorm" }
                ]
            }
        });

        // Fullscreen pass pipeline
        this.fullscreenBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "gbuffer sample BGL",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
            ]
        });
        this.fullscreenBindGroup = renderer.device.createBindGroup({
            label: "gbuffer sample BG",
            layout: this.fullscreenBindGroupLayout,
            entries: [
                { binding: 0, resource: this.gPositionView },
                { binding: 1, resource: this.gNormalView },
                { binding: 2, resource: this.gAlbedoView },
                { binding: 3, resource: this.gbufferSampler }
            ]
        });

        this.fullscreenPipeline = renderer.device.createRenderPipeline({
            layout: renderer.device.createPipelineLayout({
                label: "clustered deferred fullscreen layout",
                bindGroupLayouts: [ this.sceneUniformsBindGroupLayout, this.fullscreenBindGroupLayout ]
            }),
            vertex: {
                module: renderer.device.createShaderModule({ code: shaders.clusteredDeferredFullscreenVertSrc }),
            },
            fragment: {
                module: renderer.device.createShaderModule({ code: shaders.clusteredDeferredFullscreenFragSrc }),
                targets: [ { format: 'rgba8unorm' } ]
            }
        });

        // Toon compute
        this.ppOutputTex = renderer.device.createTexture({ label: 'toon out', size, format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
        this.ppOutputView = this.ppOutputTex.createView();
        this.ppComputeBGL = renderer.device.createBindGroupLayout({
            label: 'toon compute BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: {} },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
            ]
        });
        this.ppUniformsBuffer = renderer.device.createBuffer({ label: 'toon uniforms', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        renderer.device.queue.writeBuffer(this.ppUniformsBuffer, 0, new Float32Array([this.toonLevels, this.toonThreshold, 0, 0]));
        this.ppComputeBG = renderer.device.createBindGroup({
            label: 'toon compute BG', layout: this.ppComputeBGL,
            entries: [
                { binding: 0, resource: this.sceneColorView },
                { binding: 1, resource: this.depthTextureView },
                { binding: 2, resource: this.ppOutputView },
                { binding: 3, resource: { buffer: this.ppUniformsBuffer } }
            ]
        });
        this.ppComputePipeline = renderer.device.createComputePipeline({
            label: 'toon compute pipeline',
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [ this.ppComputeBGL ] }),
            compute: { module: renderer.device.createShaderModule({ code: shaders.postProcessingComputeSrc }), entryPoint: 'main' }
        });

        // Copy pipeline to present to canvas
        this.copyBGL = renderer.device.createBindGroupLayout({ label: 'copy BGL', entries: [ { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} } ] });
        const copySampler = renderer.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
        this.copyFromToonBG = renderer.device.createBindGroup({ label: 'copy BG toon', layout: this.copyBGL, entries: [ { binding: 0, resource: this.ppOutputView }, { binding: 1, resource: copySampler } ] });
        this.copyFromSceneBG = renderer.device.createBindGroup({ label: 'copy BG scene', layout: this.copyBGL, entries: [ { binding: 0, resource: this.sceneColorView }, { binding: 1, resource: copySampler } ] });
        this.copyPipeline = renderer.device.createRenderPipeline({ label: 'copy pipeline', layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [ this.copyBGL ] }), vertex: { module: renderer.device.createShaderModule({ code: shaders.fullscreenCopyVertSrc }) }, fragment: { module: renderer.device.createShaderModule({ code: shaders.fullscreenCopyFragSrc }), targets: [ { format: renderer.canvasFormat } ] } });
    }

    override draw() {
        // - run the clustering compute shader
        const encoder = renderer.device.createCommandEncoder();
        this.lights.doLightClustering(encoder);

        // - run the G-buffer pass, outputting position, albedo, and normals
        const gbufPass = encoder.beginRenderPass({
            label: "gbuffer pass",
            colorAttachments: [
                { view: this.gPositionView, clearValue: [0,0,0,0], loadOp: "clear", storeOp: "store" },
                { view: this.gNormalView,   clearValue: [0,0,0,0], loadOp: "clear", storeOp: "store" },
                { view: this.gAlbedoView,   clearValue: [0,0,0,0], loadOp: "clear", storeOp: "store" },
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store"
            }
        });

        gbufPass.setPipeline(this.gbufferPipeline);
        gbufPass.setBindGroup(0, this.sceneUniformsBindGroup);

        this.scene.iterate(node => {
            gbufPass.setBindGroup(1, node.modelBindGroup);
        }, material => {
            gbufPass.setBindGroup(2, material.materialBindGroup);
        }, primitive => {
            gbufPass.setVertexBuffer(0, primitive.vertexBuffer);
            gbufPass.setIndexBuffer(primitive.indexBuffer, 'uint32');
            gbufPass.drawIndexed(primitive.numIndices);
        });

        gbufPass.end();

        // - run the fullscreen pass, which reads from the G-buffer and performs lighting calculations into offscreen color
        const fsPass = encoder.beginRenderPass({
            label: "clustered deferred lighting pass",
            colorAttachments: [ { view: this.sceneColorView, clearValue: [0,0,0,0], loadOp: "clear", storeOp: "store" } ]
        });
        fsPass.setPipeline(this.fullscreenPipeline);
        fsPass.setBindGroup(0, this.sceneUniformsBindGroup);
        fsPass.setBindGroup(1, this.fullscreenBindGroup);
        fsPass.draw(3);
        fsPass.end();

        // Toon compute (optional)
        if (this.toonEnabled) {
            const computePass = encoder.beginComputePass({ label: 'toon compute pass' });
            computePass.setPipeline(this.ppComputePipeline);
            computePass.setBindGroup(0, this.ppComputeBG);
            const wgX = Math.ceil(renderer.canvas.width / 8);
            const wgY = Math.ceil(renderer.canvas.height / 8);
            computePass.dispatchWorkgroups(wgX, wgY);
            computePass.end();
        }

        // Present
        const canvasTextureView = renderer.context.getCurrentTexture().createView();
        const copyPass = encoder.beginRenderPass({ label: 'present pass', colorAttachments: [ { view: canvasTextureView, clearValue: [0,0,0,0], loadOp: 'clear', storeOp: 'store' } ] });
        copyPass.setPipeline(this.copyPipeline);
        copyPass.setBindGroup(0, this.toonEnabled ? this.copyFromToonBG : this.copyFromSceneBG);
        copyPass.draw(3);
        copyPass.end();

        renderer.device.queue.submit([encoder.finish()]);
    }

    override setToonEnabled(enabled: boolean): void {
        this.toonEnabled = enabled;
    }
    override setToonLevels(levels: number): void {
        this.toonLevels = levels;
        renderer.device.queue.writeBuffer(this.ppUniformsBuffer, 0, new Float32Array([this.toonLevels, this.toonThreshold, 0, 0]));
    }
    override setToonThreshold(threshold: number): void {
        this.toonThreshold = threshold;
        renderer.device.queue.writeBuffer(this.ppUniformsBuffer, 0, new Float32Array([this.toonLevels, this.toonThreshold, 0, 0]));
    }
}
