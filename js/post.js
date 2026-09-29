// Loads the same-revision (r160) three.js post-processing + environment addons
// as ES modules and hands them to the classic-script renderer. If this module
// fails to load, the renderer simply draws without post-processing.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

window.SpotKickPost = {
  EffectComposer, RenderPass, ShaderPass, OutputPass, UnrealBloomPass, SMAAPass,
  FXAAShader, RoomEnvironment
};
window.dispatchEvent(new Event('spotkick-post-ready'));
