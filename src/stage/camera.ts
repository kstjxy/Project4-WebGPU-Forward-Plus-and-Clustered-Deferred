import { Mat4, mat4, Vec3, vec3 } from "wgpu-matrix";
import { toRadians } from "../math_util";
import { device, canvas, fovYDegrees, aspectRatio } from "../renderer";

class CameraUniforms {
    // Layout (floats):
    // 0..15   viewProjMat (mat4x4)
    // 16..31  viewMat (mat4x4)
    // 32..47  projMat (mat4x4)
    // 48..63  invProjMat (mat4x4)
    // 64      nearPlane
    // 65      farPlane
    // 66..67  padding
    // 68..69  screenSize (width, height)
    // 70..71  padding
    readonly buffer = new ArrayBuffer(72 * 4);
    private readonly floatView = new Float32Array(this.buffer);

    set viewProjMat(mat: Float32Array) {
        this.floatView.set(mat.subarray(0, 16), 0);
    }

    set viewMat(mat: Float32Array) {
        this.floatView.set(mat.subarray(0, 16), 16);
    }

    set projMat(mat: Float32Array) {
        this.floatView.set(mat.subarray(0, 16), 32);
    }

    set invProjMat(mat: Float32Array) {
        this.floatView.set(mat.subarray(0, 16), 48);
    }

    set nearFar(vals: [number, number]) {
        this.floatView[64] = vals[0];
        this.floatView[65] = vals[1];
    }

    screenSizeWH(width: number, height: number) {
        this.floatView[68] = width;
        this.floatView[69] = height;
    }
}

export class Camera {
    uniforms: CameraUniforms = new CameraUniforms();
    uniformsBuffer: GPUBuffer;

    projMat: Mat4 = mat4.create();
    cameraPos: Vec3 = vec3.create(-7, 2, 0);
    cameraFront: Vec3 = vec3.create(0, 0, -1);
    cameraUp: Vec3 = vec3.create(0, 1, 0);
    cameraRight: Vec3 = vec3.create(1, 0, 0);
    yaw: number = 0;
    pitch: number = 0;
    moveSpeed: number = 0.004;
    sensitivity: number = 0.15;

    static readonly nearPlane = 0.1;
    static readonly farPlane = 1000;

    keys: { [key: string]: boolean } = {};

    constructor () {
        // create GPU buffer for camera uniforms (view-projection matrix)
        this.uniformsBuffer = device.createBuffer({
            label: "camera uniforms",
            size: this.uniforms.buffer.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        // note that you can add more variables (e.g. inverse proj matrix) to this buffer in later parts of the assignment

        this.projMat = mat4.perspective(toRadians(fovYDegrees), aspectRatio, Camera.nearPlane, Camera.farPlane);

        this.rotateCamera(0, 0); // set initial camera vectors

        window.addEventListener('keydown', (event) => this.onKeyEvent(event, true));
        window.addEventListener('keyup', (event) => this.onKeyEvent(event, false));
        window.onblur = () => this.keys = {}; // reset keys on page exit so they don't get stuck (e.g. on alt + tab)

        canvas.addEventListener('mousedown', () => canvas.requestPointerLock());
        canvas.addEventListener('mouseup', () => document.exitPointerLock());
        canvas.addEventListener('mousemove', (event) => this.onMouseMove(event));
    }

    private onKeyEvent(event: KeyboardEvent, down: boolean) {
        this.keys[event.key.toLowerCase()] = down;
        if (this.keys['alt']) { // prevent issues from alt shortcuts
            event.preventDefault();
        }
    }

    private rotateCamera(dx: number, dy: number) {
        this.yaw += dx;
        this.pitch -= dy;

        if (this.pitch > 89) {
            this.pitch = 89;
        }
        if (this.pitch < -89) {
            this.pitch = -89;
        }

        const front = mat4.create();
        front[0] = Math.cos(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch));
        front[1] = Math.sin(toRadians(this.pitch));
        front[2] = Math.sin(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch));

        this.cameraFront = vec3.normalize(front);
        this.cameraRight = vec3.normalize(vec3.cross(this.cameraFront, [0, 1, 0]));
        this.cameraUp = vec3.normalize(vec3.cross(this.cameraRight, this.cameraFront));
    }

    private onMouseMove(event: MouseEvent) {
        if (document.pointerLockElement === canvas) {
            this.rotateCamera(event.movementX * this.sensitivity, event.movementY * this.sensitivity);
        }
    }

    private processInput(deltaTime: number) {
        let moveDir = vec3.create(0, 0, 0);
        if (this.keys['w']) {
            moveDir = vec3.add(moveDir, this.cameraFront);
        }
        if (this.keys['s']) {
            moveDir = vec3.sub(moveDir, this.cameraFront);
        }
        if (this.keys['a']) {
            moveDir = vec3.sub(moveDir, this.cameraRight);
        }
        if (this.keys['d']) {
            moveDir = vec3.add(moveDir, this.cameraRight);
        }
        if (this.keys['q']) {
            moveDir = vec3.sub(moveDir, this.cameraUp);
        }
        if (this.keys['e']) {
            moveDir = vec3.add(moveDir, this.cameraUp);
        }

        let moveSpeed = this.moveSpeed * deltaTime;
        const moveSpeedMultiplier = 3;
        if (this.keys['shift']) {
            moveSpeed *= moveSpeedMultiplier;
        }
        if (this.keys['alt']) {
            moveSpeed /= moveSpeedMultiplier;
        }

        if (vec3.length(moveDir) > 0) {
            const moveAmount = vec3.scale(vec3.normalize(moveDir), moveSpeed);
            this.cameraPos = vec3.add(this.cameraPos, moveAmount);
        }
    }

    onFrame(deltaTime: number) {
        this.processInput(deltaTime);

        const lookPos = vec3.add(this.cameraPos, vec3.scale(this.cameraFront, 1));
        const viewMat = mat4.lookAt(this.cameraPos, lookPos, [0, 1, 0]);
        const viewProjMat = mat4.mul(this.projMat, viewMat);
        // upload latest view-projection matrix to host-side uniform buffer
        this.uniforms.viewProjMat = viewProjMat as unknown as Float32Array;
        // extra camera data for clustering
        this.uniforms.viewMat = viewMat as unknown as Float32Array;
        this.uniforms.projMat = this.projMat as unknown as Float32Array;
        const invProj = mat4.inverse(this.projMat);
        this.uniforms.invProjMat = invProj as unknown as Float32Array;
        this.uniforms.nearFar = [Camera.nearPlane, Camera.farPlane];
        this.uniforms.screenSizeWH(canvas.width, canvas.height);

        // upload host-side buffer to device uniform buffer
        device.queue.writeBuffer(this.uniformsBuffer, 0, this.uniforms.buffer);
    }
}
