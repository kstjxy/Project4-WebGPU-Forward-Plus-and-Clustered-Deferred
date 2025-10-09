import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export class ForwardPlusRenderer extends renderer.Renderer {
    // layouts, pipelines, textures, etc. needed for Forward+
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;

    // main scene color + depth
    sceneColorTex: GPUTexture; sceneColorView: GPUTextureView;
    depthTexture: GPUTexture; depthTextureView: GPUTextureView;

    pipeline: GPURenderPipeline;

    // post-processing (toon) compute
    ppOutputTex: GPUTexture; ppOutputView: GPUTextureView;
    ppComputeBGL: GPUBindGroupLayout; ppComputeBG: GPUBindGroup;
    ppComputePipeline: GPUComputePipeline;
    ppUniformsBuffer: GPUBuffer;

    // fullscreen copy to canvas
    copyBGL: GPUBindGroupLayout; copyFromToonBG: GPUBindGroup; copyFromSceneBG: GPUBindGroup;
    copyPipeline: GPURenderPipeline;

    // toon settings
    private toonEnabled: boolean = false;
    private toonLevels: number = 4;
    private toonThreshold: number = 0.0025;

    constructor(stage: Stage) {
        super(stage);

        // scene uniforms (camera + lights + clusters)
        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "forward+ scene uniforms BGL",
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
            label: "forward+ scene uniforms BG",
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.lights.clusterLightsStorageBuffer } }
            ]
        });

        const size: GPUExtent3D = [renderer.canvas.width, renderer.canvas.height];
        this.sceneColorTex = renderer.device.createTexture({
            label: "forward+ scene color",
            size,
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.sceneColorView = this.sceneColorTex.createView();

        this.depthTexture = renderer.device.createTexture({
            size,
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.depthTextureView = this.depthTexture.createView();

        this.pipeline = renderer.device.createRenderPipeline({
            layout: renderer.device.createPipelineLayout({
                label: "forward+ pipeline layout",
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
                    label: "naive vert shader",
                    code: shaders.naiveVertSrc
                }),
                buffers: [ renderer.vertexBufferLayout ]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "forward+ frag shader",
                    code: shaders.forwardPlusFragSrc,
                }),
                targets: [ { format: 'rgba8unorm' } ]
            }
        });

        // Post-processing output texture
        this.ppOutputTex = renderer.device.createTexture({
            label: "toon output",
            size,
            format: "rgba8unorm",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
        });
        this.ppOutputView = this.ppOutputTex.createView();

        // Toon compute pipeline
        this.ppComputeBGL = renderer.device.createBindGroupLayout({
            label: "toon compute BGL",
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
            label: "toon compute BG",
            layout: this.ppComputeBGL,
            entries: [
                { binding: 0, resource: this.sceneColorView },
                { binding: 1, resource: this.depthTextureView },
                { binding: 2, resource: this.ppOutputView },
                { binding: 3, resource: { buffer: this.ppUniformsBuffer } }
            ]
        });
        this.ppComputePipeline = renderer.device.createComputePipeline({
            label: "toon compute pipeline",
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [ this.ppComputeBGL ] }),
            compute: { module: renderer.device.createShaderModule({ code: shaders.postProcessingComputeSrc }), entryPoint: 'main' }
        });

        // Fullscreen copy pipeline to present to canvas
        this.copyBGL = renderer.device.createBindGroupLayout({
            label: "copy BGL",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
            ]
        });
        const copySampler = renderer.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
        this.copyFromToonBG = renderer.device.createBindGroup({
            label: "copy BG toon",
            layout: this.copyBGL,
            entries: [ { binding: 0, resource: this.ppOutputView }, { binding: 1, resource: copySampler } ]
        });
        this.copyFromSceneBG = renderer.device.createBindGroup({
            label: "copy BG scene",
            layout: this.copyBGL,
            entries: [ { binding: 0, resource: this.sceneColorView }, { binding: 1, resource: copySampler } ]
        });
        this.copyPipeline = renderer.device.createRenderPipeline({
            label: "copy pipeline",
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [ this.copyBGL ] }),
            vertex: { module: renderer.device.createShaderModule({ code: shaders.fullscreenCopyVertSrc }) },
            fragment: { module: renderer.device.createShaderModule({ code: shaders.fullscreenCopyFragSrc }), targets: [ { format: renderer.canvasFormat } ] }
        });
    }

    override draw() {
        // run the Forward+ rendering pass
        const encoder = renderer.device.createCommandEncoder();

        // 1) clustering compute pass
        this.lights.doLightClustering(encoder);

        // 2) main render pass into offscreen color
        const renderPass = encoder.beginRenderPass({
            label: "forward+ render pass",
            colorAttachments: [
                {
                    view: this.sceneColorView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store"
                }
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store"
            }
        });
        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);

        this.scene.iterate(node => {
            renderPass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
        }, material => {
            renderPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
        }, primitive => {
            renderPass.setVertexBuffer(0, primitive.vertexBuffer);
            renderPass.setIndexBuffer(primitive.indexBuffer, 'uint32');
            renderPass.drawIndexed(primitive.numIndices);
        });

        renderPass.end();

        // 3) Toon compute
        if (this.toonEnabled) {
            const computePass = encoder.beginComputePass({ label: 'toon compute pass' });
            computePass.setPipeline(this.ppComputePipeline);
            computePass.setBindGroup(0, this.ppComputeBG);
            const wgX = Math.ceil(renderer.canvas.width / 8);
            const wgY = Math.ceil(renderer.canvas.height / 8);
            computePass.dispatchWorkgroups(wgX, wgY);
            computePass.end();
        }

        // 4) Present to canvas via copy pass
        const canvasTextureView = renderer.context.getCurrentTexture().createView();
        const copyPass = encoder.beginRenderPass({
            label: 'present pass',
            colorAttachments: [ { view: canvasTextureView, clearValue: [0,0,0,0], loadOp: 'clear', storeOp: 'store' } ]
        });
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
