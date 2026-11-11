// Small local-only CBCT volume preview. The texture contains sampled voxels,
// never full diagnostic resolution or data sent to a server.

export function packVolumeLayers(layers, width, height, depthRatio = 0.8){
  if (layers.length < 2 || !width || !height ||
      layers.some(layer => layer.length !== width * height)) return null;
  const histogram = new Uint32Array(65536);
  for (const layer of layers) {
    for (const value of layer) histogram[value + 32768]++;
  }
  const total = layers.length * width * height;
  const percentile = fraction => {
    const target = total * fraction;
    let seen = 0;
    for (let i = 0; i < histogram.length; i++) {
      seen += histogram[i];
      if (seen >= target) return i - 32768;
    }
    return 32767;
  };
  const lo = percentile(0.12);
  const hi = Math.max(lo + 1, percentile(0.997));
  const data = new Uint8Array(total);
  const scale = 255 / (hi - lo);
  for (let z = 0; z < layers.length; z++) {
    const layer = layers[z], offset = z * width * height;
    for (let i = 0; i < layer.length; i++) {
      data[offset + i] = Math.max(0, Math.min(255, Math.round((layer[i] - lo) * scale)));
    }
  }
  return {data, width, height, depth: layers.length,
    shape: [1, height / width, Math.max(0.35, Math.min(1.5, depthRatio))]};
}

export function previewFromVolume(volume){
  if (!volume || volume.nz < 2) return null;
  const step = Math.max(1, Math.ceil(Math.max(volume.nx, volume.ny) / 128));
  const width = Math.floor(volume.nx / step), height = Math.floor(volume.ny / step);
  const count = Math.min(64, volume.nz);
  const layers = [];
  for (let z = 0; z < count; z++) {
    const source = volume.data[Math.round(z * (volume.nz - 1) / (count - 1))];
    const layer = new Int16Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) layer[y * width + x] = source[y * step * volume.nx + x * step];
    }
    layers.push(layer);
  }
  const depthMm = volume.sz * (volume.nz - 1);
  const widthMm = Math.max(volume.sx * volume.nx, volume.sy * volume.ny);
  return packVolumeLayers(layers, width, height, depthMm / widthMm);
}

const VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4) ? 1.0 : -1.0,
                (gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5) ? 1.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler3D uVolume;
uniform vec3 uShape;
uniform vec3 uTexel;
uniform vec2 uAngles;
uniform float uAspect;
uniform float uZoom;
uniform float uThreshold;

vec3 toObject(vec3 p){
  float cy = cos(uAngles.x), sy = sin(uAngles.x);
  float cp = cos(uAngles.y), sp = sin(uAngles.y);
  vec3 q = vec3(p.x, cp * p.y + sp * p.z, -sp * p.y + cp * p.z);
  return vec3(cy * q.x - sy * q.z, q.y, sy * q.x + cy * q.z);
}

void main(){
  vec2 screen = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0) * (0.8 / uZoom);
  vec3 origin = toObject(vec3(screen, -1.6));
  vec3 dir = toObject(vec3(0.0, 0.0, 1.0));
  vec3 safeDir = dir + vec3(0.000001);
  vec3 ta = (-0.5 * uShape - origin) / safeDir;
  vec3 tb = ( 0.5 * uShape - origin) / safeDir;
  vec3 low = min(ta, tb), high = max(ta, tb);
  float nearT = max(max(low.x, low.y), max(low.z, 0.0));
  float farT = min(min(high.x, high.y), high.z);
  if (nearT >= farT) { fragColor = vec4(0.015, 0.02, 0.025, 1.0); return; }

  for (int i = 0; i < 128; i++) {
    float t = mix(nearT, farT, (float(i) + 0.5) / 128.0);
    vec3 coord = (origin + t * dir) / uShape + 0.5;
    float density = texture(uVolume, coord).r;
    if (density > uThreshold) {
      vec3 gradient = vec3(
        texture(uVolume, coord + vec3(uTexel.x, 0.0, 0.0)).r - texture(uVolume, coord - vec3(uTexel.x, 0.0, 0.0)).r,
        texture(uVolume, coord + vec3(0.0, uTexel.y, 0.0)).r - texture(uVolume, coord - vec3(0.0, uTexel.y, 0.0)).r,
        texture(uVolume, coord + vec3(0.0, 0.0, uTexel.z)).r - texture(uVolume, coord - vec3(0.0, 0.0, uTexel.z)).r);
      vec3 normal = normalize(gradient + vec3(0.00001));
      vec3 lightDir = normalize(toObject(vec3(-0.4, 0.7, -0.6)));
      float light = 0.42 + 0.58 * abs(dot(normal, lightDir));
      vec3 bone = vec3(0.84, 0.88, 0.83) * light * (0.75 + 0.25 * density);
      fragColor = vec4(bone, 1.0);
      return;
    }
  }
  fragColor = vec4(0.015, 0.02, 0.025, 1.0);
}`;

export function createVolumeViewer(canvas){
  const gl = canvas.getContext('webgl2', {alpha: false, antialias: false});
  if (!gl) return null;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const uniforms = Object.fromEntries(['uVolume', 'uShape', 'uTexel', 'uAngles',
    'uAspect', 'uZoom', 'uThreshold'].map(name => [name, gl.getUniformLocation(program, name)]));
  const state = {yaw: 0.35, pitch: -0.25, zoom: 1, threshold: 0.58, volume: null, texture: null};
  let scheduled = false;
  const draw = () => {
    scheduled = false;
    if (!state.volume) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, state.texture);
    gl.uniform1i(uniforms.uVolume, 0);
    gl.uniform3fv(uniforms.uShape, state.volume.shape);
    gl.uniform3f(uniforms.uTexel, 1 / state.volume.width, 1 / state.volume.height, 1 / state.volume.depth);
    gl.uniform2f(uniforms.uAngles, state.yaw, state.pitch);
    gl.uniform1f(uniforms.uAspect, canvas.width / canvas.height);
    gl.uniform1f(uniforms.uZoom, state.zoom);
    gl.uniform1f(uniforms.uThreshold, state.threshold);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  const requestDraw = () => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(draw); }
  };
  return {
    setVolume(volume){
      if (state.volume === volume && state.texture) { requestDraw(); return; }
      if (state.texture) gl.deleteTexture(state.texture);
      state.volume = volume;
      state.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, state.texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
        gl.texParameteri(gl.TEXTURE_3D, axis, gl.CLAMP_TO_EDGE);
      }
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, volume.width, volume.height,
        volume.depth, 0, gl.RED, gl.UNSIGNED_BYTE, volume.data);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('3D texture upload failed');
      requestDraw();
    },
    resize(){
      const cssWidth = Math.max(1, canvas.clientWidth * devicePixelRatio);
      const cssHeight = Math.max(1, canvas.clientHeight * devicePixelRatio);
      const scale = Math.min(1, 640 / Math.max(cssWidth, cssHeight));
      const width = Math.max(1, Math.round(cssWidth * scale));
      const height = Math.max(1, Math.round(cssHeight * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      requestDraw();
    },
    rotate(dx, dy){
      state.yaw += dx;
      state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch + dy));
      requestDraw();
    },
    zoom(factor){
      state.zoom = Math.max(0.5, Math.min(4, state.zoom * factor));
      requestDraw();
    },
    setThreshold(value){ state.threshold = value; requestDraw(); },
    reset(){ state.yaw = 0.35; state.pitch = -0.25; state.zoom = 1; requestDraw(); },
    clear(){
      if (state.texture) gl.deleteTexture(state.texture);
      state.texture = null;
      state.volume = null;
      gl.clearColor(0.015, 0.02, 0.025, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw: requestDraw
  };
}
