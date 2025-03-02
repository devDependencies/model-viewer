/* @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AnimationAction, AnimationClip, AnimationMixer, Box3, Camera, Event as ThreeEvent, Matrix3, Object3D, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3} from 'three';
import {CSS2DRenderer} from 'three/examples/jsm/renderers/CSS2DRenderer';

import ModelViewerElementBase, {$renderer, RendererInterface} from '../model-viewer-base.js';
import {resolveDpr} from '../utilities.js';

import {Damper, SETTLING_TIME} from './Damper.js';
import {ModelViewerGLTFInstance} from './gltf-instance/ModelViewerGLTFInstance.js';
import {Hotspot} from './Hotspot.js';
import {reduceVertices} from './ModelUtils.js';
import {Shadow} from './Shadow.js';



export interface ModelLoadEvent extends ThreeEvent {
  url: string;
}

export interface ModelSceneConfig {
  element: ModelViewerElementBase;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export type IlluminationRole = 'primary'|'secondary';

export const IlluminationRole: {[index: string]: IlluminationRole} = {
  Primary: 'primary',
  Secondary: 'secondary'
};

export const DEFAULT_FOV_DEG = 45;
const DEFAULT_HALF_FOV = (DEFAULT_FOV_DEG / 2) * Math.PI / 180;
export const SAFE_RADIUS_RATIO = Math.sin(DEFAULT_HALF_FOV);
export const DEFAULT_TAN_FOV = Math.tan(DEFAULT_HALF_FOV);

const view = new Vector3();
const target = new Vector3();
const normalWorld = new Vector3();

const raycaster = new Raycaster();
const vector3 = new Vector3();

/**
 * A THREE.Scene object that takes a Model and CanvasHTMLElement and
 * constructs a framed scene based off of the canvas dimensions.
 * Provides lights and cameras to be used in a renderer.
 */
export class ModelScene extends Scene {
  public element: ModelViewerElementBase;
  public canvas: HTMLCanvasElement;
  public context: CanvasRenderingContext2D|ImageBitmapRenderingContext|null =
      null;
  public annotationRenderer = new CSS2DRenderer();
  public width = 1;
  public height = 1;
  public aspect = 1;
  public isDirty = false;
  public renderCount = 0;
  public externalRenderer: RendererInterface|null = null;

  // These default camera values are never used, as they are reset once the
  // model is loaded and framing is computed.
  public camera = new PerspectiveCamera(45, 1, 0.1, 100);
  public xrCamera: Camera|null = null;

  public url: string|null = null;
  public target = new Object3D();
  public modelContainer = new Object3D();
  public animationNames: Array<string> = [];
  public boundingBox = new Box3();
  public size = new Vector3();
  public idealCameraDistance = 0;
  public fieldOfViewAspect = 0;
  public framedFieldOfView = DEFAULT_FOV_DEG;

  public shadow: Shadow|null = null;
  public shadowIntensity = 0;
  public shadowSoftness = 1;

  public exposure = 1;
  public canScale = true;
  public tightBounds = false;

  private goalTarget = new Vector3();
  private targetDamperX = new Damper();
  private targetDamperY = new Damper();
  private targetDamperZ = new Damper();

  private _currentGLTF: ModelViewerGLTFInstance|null = null;
  private mixer: AnimationMixer;
  private cancelPendingSourceChange: (() => void)|null = null;
  private animationsByName: Map<string, AnimationClip> = new Map();
  private currentAnimationAction: AnimationAction|null = null;

  constructor({canvas, element, width, height}: ModelSceneConfig) {
    super();

    this.name = 'ModelScene';

    this.element = element;
    this.canvas = canvas;

    // These default camera values are never used, as they are reset once the
    // model is loaded and framing is computed.
    this.camera = new PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.name = 'MainCamera';

    this.add(this.target);

    this.setSize(width, height);

    this.target.name = 'Target';
    this.modelContainer.name = 'ModelContainer';

    this.target.add(this.modelContainer);
    this.mixer = new AnimationMixer(this.modelContainer);

    const {domElement} = this.annotationRenderer;
    const {style} = domElement;
    style.display = 'none';
    style.pointerEvents = 'none';
    style.position = 'absolute';
    style.top = '0';
    this.element.shadowRoot!.querySelector('.default')!.appendChild(domElement);
  }

  /**
   * Function to create the context lazily, as when there is only one
   * <model-viewer> element, the renderer's 3D context can be displayed
   * directly. This extra context is necessary to copy the renderings into when
   * there are more than one.
   */
  createContext() {
    this.context = this.canvas.getContext('2d')!;
  }

  getCamera(): Camera {
    return this.xrCamera != null ? this.xrCamera : this.camera;
  }

  /**
   * Pass in a THREE.Object3D to be controlled
   * by this model.
   */
  async setObject(model: Object3D) {
    this.reset();
    this.modelContainer.add(model);
    await this.setupScene();
  }

  /**
   * Sets the model via URL.
   */

  async setSource(
      url: string|null,
      progressCallback: (progress: number) => void = () => {}) {
    if (!url || url === this.url) {
      progressCallback(1);
      return;
    }
    this.reset();
    this.url = url;

    if (this.externalRenderer != null) {
      const framingInfo = await this.externalRenderer.load(progressCallback);

      this.idealCameraDistance = framingInfo.framedRadius / SAFE_RADIUS_RATIO;
      this.fieldOfViewAspect = framingInfo.fieldOfViewAspect;
      this.frameModel();

      this.dispatchEvent({type: 'model-load', url: this.url});
      return;
    }

    // If we have pending work due to a previous source change in progress,
    // cancel it so that we do not incur a race condition:
    if (this.cancelPendingSourceChange != null) {
      this.cancelPendingSourceChange!();
      this.cancelPendingSourceChange = null;
    }

    let gltf: ModelViewerGLTFInstance;

    try {
      gltf = await new Promise<ModelViewerGLTFInstance>(
          async (resolve, reject) => {
            this.cancelPendingSourceChange = () => reject();
            try {
              const result = await this.element[$renderer].loader.load(
                  url, this.element, progressCallback);
              resolve(result);
            } catch (error) {
              reject(error);
            }
          });
    } catch (error) {
      if (error == null) {
        // Loading was cancelled, so silently return
        return;
      }

      throw error;
    }

    this.reset();
    this.url = url;
    this._currentGLTF = gltf;

    if (gltf != null) {
      this.modelContainer.add(gltf.scene);
    }

    const {animations} = gltf!;
    const animationsByName = new Map();
    const animationNames = [];

    for (const animation of animations) {
      animationsByName.set(animation.name, animation);
      animationNames.push(animation.name);
    }

    this.animations = animations;
    this.animationsByName = animationsByName;
    this.animationNames = animationNames;

    await this.setupScene();
  }

  private async setupScene() {
    this.updateBoundingBox();

    let target = null;
    if (this.tightBounds === true) {
      await this.element.requestUpdate('cameraTarget');
      target = this.getTarget();
    }
    this.updateFraming(target);

    this.frameModel();
    this.updateShadow();
    this.setShadowIntensity(this.shadowIntensity);
    this.dispatchEvent({type: 'model-load', url: this.url});
  }

  reset() {
    this.url = null;
    this.isDirty = true;
    if (this.shadow != null) {
      this.shadow.setIntensity(0);
    }
    const gltf = this._currentGLTF;
    // Remove all current children
    if (gltf != null) {
      for (const child of this.modelContainer.children) {
        this.modelContainer.remove(child);
      }
      gltf.dispose();
      this._currentGLTF = null;
    }

    if (this.currentAnimationAction != null) {
      this.currentAnimationAction.stop();
      this.currentAnimationAction = null;
    }

    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this);
  }

  get currentGLTF() {
    return this._currentGLTF;
  }

  /**
   * Updates the ModelScene for a new container size in CSS pixels.
   */
  setSize(width: number, height: number) {
    if (this.width === width && this.height === height) {
      return;
    }
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    this.annotationRenderer.setSize(width, height);

    this.aspect = this.width / this.height;
    this.frameModel();

    if (this.externalRenderer != null) {
      const dpr = resolveDpr();
      this.externalRenderer.resize(width * dpr, height * dpr);
    }

    this.isDirty = true;
  }

  updateBoundingBox() {
    this.target.remove(this.modelContainer);

    if (this.tightBounds === true) {
      const bound = (box: Box3, vertex: Vector3): Box3 => {
        return box.expandByPoint(vertex);
      };
      this.boundingBox = reduceVertices(this.modelContainer, bound, new Box3());
    } else {
      this.boundingBox.setFromObject(this.modelContainer);
    }
    this.boundingBox.getSize(this.size);

    this.target.add(this.modelContainer);
  }

  /**
   * Calculates the idealCameraDistance and fieldOfViewAspect that allows the 3D
   * object to be framed tightly in a 2D window of any aspect ratio without
   * clipping at any camera orbit. The camera's center target point can be
   * optionally specified. If no center is specified, it defaults to the center
   * of the bounding box, which means asymmetric models will tend to be tight on
   * one side instead of both. Proper choice of center can correct this.
   */
  updateFraming(center: Vector3|null = null) {
    this.target.remove(this.modelContainer);

    if (center == null) {
      center = this.boundingBox.getCenter(new Vector3());
    }

    const radiusSquared = (value: number, vertex: Vector3): number => {
      return Math.max(value, center!.distanceToSquared(vertex));
    };
    const framedRadius =
        Math.sqrt(reduceVertices(this.modelContainer, radiusSquared, 0));

    this.idealCameraDistance = framedRadius / SAFE_RADIUS_RATIO;

    const horizontalFov = (value: number, vertex: Vector3): number => {
      vertex.sub(center!);
      const radiusXZ = Math.sqrt(vertex.x * vertex.x + vertex.z * vertex.z);
      return Math.max(
          value, radiusXZ / (this.idealCameraDistance - Math.abs(vertex.y)));
    };
    this.fieldOfViewAspect =
        reduceVertices(this.modelContainer, horizontalFov, 0) / DEFAULT_TAN_FOV;

    this.target.add(this.modelContainer);
  }

  /**
   * Set's the framedFieldOfView based on the aspect ratio of the window in
   * order to keep the model fully visible at any camera orientation.
   */
  frameModel() {
    const vertical =
        DEFAULT_TAN_FOV * Math.max(1, this.fieldOfViewAspect / this.aspect);
    this.framedFieldOfView = 2 * Math.atan(vertical) * 180 / Math.PI;
  }

  /**
   * Returns the size of the corresponding canvas element.
   */
  getSize(): {width: number, height: number} {
    return {width: this.width, height: this.height};
  }

  /**
   * Sets the point in model coordinates the model should orbit/pivot around.
   */
  setTarget(modelX: number, modelY: number, modelZ: number) {
    this.goalTarget.set(-modelX, -modelY, -modelZ);
  }

  /**
   * Set the decay time of, affects the speed of target transitions.
   */
  setTargetDamperDecayTime(decayMilliseconds: number) {
    this.targetDamperX.setDecayTime(decayMilliseconds);
    this.targetDamperY.setDecayTime(decayMilliseconds);
    this.targetDamperZ.setDecayTime(decayMilliseconds);
  }

  /**
   * Gets the point in model coordinates the model should orbit/pivot around.
   */
  getTarget(): Vector3 {
    return vector3.copy(this.goalTarget).multiplyScalar(-1);
  }

  /**
   * Shifts the model to the target point immediately instead of easing in.
   */
  jumpToGoal() {
    this.updateTarget(SETTLING_TIME);
  }

  /**
   * This should be called every frame with the frame delta to cause the target
   * to transition to its set point.
   */
  updateTarget(delta: number) {
    const goal = this.goalTarget;
    const target = this.target.position;
    if (!goal.equals(target)) {
      const radius = this.idealCameraDistance;
      let {x, y, z} = target;
      x = this.targetDamperX.update(x, goal.x, delta, radius);
      y = this.targetDamperY.update(y, goal.y, delta, radius);
      z = this.targetDamperZ.update(z, goal.z, delta, radius);
      this.target.position.set(x, y, z);
      this.target.updateMatrixWorld();
      this.setShadowRotation(this.yaw);
      this.isDirty = true;
    }
  }

  /**
   * Yaw the +z (front) of the model toward the indicated world coordinates.
   */
  pointTowards(worldX: number, worldZ: number) {
    const {x, z} = this.position;
    this.yaw = Math.atan2(worldX - x, worldZ - z);
  }

  /**
   * Yaw is the scene's orientation about the y-axis, around the rotation
   * center.
   */
  set yaw(radiansY: number) {
    this.rotation.y = radiansY;
    this.updateMatrixWorld(true);
    this.setShadowRotation(radiansY);
    this.isDirty = true;
  }

  get yaw(): number {
    return this.rotation.y;
  }

  set animationTime(value: number) {
    this.mixer.setTime(value);
  }

  get animationTime(): number {
    if (this.currentAnimationAction != null) {
      return this.currentAnimationAction.time;
    }

    return 0;
  }

  get duration(): number {
    if (this.currentAnimationAction != null &&
        this.currentAnimationAction.getClip()) {
      return this.currentAnimationAction.getClip().duration;
    }

    return 0;
  }

  get hasActiveAnimation(): boolean {
    return this.currentAnimationAction != null;
  }

  /**
   * Plays an animation if there are any associated with the current model.
   * Accepts an optional string name of an animation to play. If no name is
   * provided, or if no animation is found by the given name, always falls back
   * to playing the first animation.
   */
  playAnimation(name: string|null = null, crossfadeTime: number = 0) {
    if (this._currentGLTF == null) {
      return;
    }
    const {animations} = this;
    if (animations == null || animations.length === 0) {
      console.warn(
          `Cannot play animation (model does not have any animations)`);
      return;
    }

    let animationClip = null;

    if (name != null) {
      animationClip = this.animationsByName.get(name);
    }

    if (animationClip == null) {
      animationClip = animations[0];
    }

    try {
      const {currentAnimationAction: lastAnimationAction} = this;

      const action = this.mixer.clipAction(animationClip, this);
      this.currentAnimationAction = action;

      if ((this.element as any).paused) {
        this.mixer.stopAllAction();
      } else if (
          lastAnimationAction != null && action !== lastAnimationAction) {
        action.crossFadeFrom(lastAnimationAction, crossfadeTime, false);
      }

      action.enabled = true;
      action.play();
    } catch (error) {
      console.error(error);
    }
  }

  stopAnimation() {
    this.currentAnimationAction = null;
    this.mixer.stopAllAction();
  }

  updateAnimation(step: number) {
    this.mixer.update(step);
  }

  /**
   * Call if the object has been changed in such a way that the shadow's shape
   * has changed (not a rotation about the Y axis).
   */
  updateShadow() {
    const shadow = this.shadow;
    if (shadow != null) {
      const side =
          (this.element as any).arPlacement === 'wall' ? 'back' : 'bottom';
      shadow.setScene(this, this.shadowSoftness, side);
      shadow.setRotation(this.yaw);
    }
  }

  /**
   * Sets the shadow's intensity, lazily creating the shadow as necessary.
   */
  setShadowIntensity(shadowIntensity: number) {
    this.shadowIntensity = shadowIntensity;
    if (this._currentGLTF == null) {
      return;
    }
    if (shadowIntensity <= 0 && this.shadow == null) {
      return;
    }

    if (this.shadow == null) {
      const side =
          (this.element as any).arPlacement === 'wall' ? 'back' : 'bottom';
      this.shadow = new Shadow(this, this.shadowSoftness, side);
      this.shadow.setRotation(this.yaw);
    }
    this.shadow.setIntensity(shadowIntensity);
  }

  /**
   * Sets the shadow's softness by mapping a [0, 1] softness parameter to the
   * shadow's resolution. This involves reallocation, so it should not be
   * changed frequently. Softer shadows are cheaper to render.
   */
  setShadowSoftness(softness: number) {
    this.shadowSoftness = softness;
    const shadow = this.shadow;
    if (shadow != null) {
      shadow.setSoftness(softness);
    }
  }

  /**
   * The shadow must be rotated manually to match any global rotation applied to
   * this model. The input is the global orientation about the Y axis.
   */
  setShadowRotation(radiansY: number) {
    const shadow = this.shadow;
    if (shadow != null) {
      shadow.setRotation(radiansY);
    }
  }

  /**
   * Call to check if the shadow needs an updated render; returns true if an
   * update is needed and resets the state.
   */
  isShadowDirty(): boolean {
    const shadow = this.shadow;
    if (shadow == null) {
      return false;
    } else {
      const {needsUpdate} = shadow;
      shadow.needsUpdate = false;
      return needsUpdate;
    }
  }

  /**
   * Shift the floor vertically from the bottom of the model's bounding box by
   * offset (should generally be negative).
   */
  setShadowScaleAndOffset(scale: number, offset: number) {
    const shadow = this.shadow;
    if (shadow != null) {
      shadow.setScaleAndOffset(scale, offset);
    }
  }

  /**
   * This method returns the world position and model-space normal of the point
   * on the mesh corresponding to the input pixel coordinates given relative to
   * the model-viewer element. If the mesh is not hit, the result is null.
   */
  positionAndNormalFromPoint(pixelPosition: Vector2, object: Object3D = this):
      {position: Vector3, normal: Vector3}|null {
    raycaster.setFromCamera(pixelPosition, this.getCamera());
    const hits = raycaster.intersectObject(object, true);

    if (hits.length === 0) {
      return null;
    }

    const hit = hits[0];
    if (hit.face == null) {
      return null;
    }

    hit.face.normal.applyNormalMatrix(
        new Matrix3().getNormalMatrix(hit.object.matrixWorld));

    return {position: hit.point, normal: hit.face.normal};
  }

  /**
   * The following methods are for operating on the set of Hotspot objects
   * attached to the scene. These come from DOM elements, provided to slots by
   * the Annotation Mixin.
   */
  addHotspot(hotspot: Hotspot) {
    this.target.add(hotspot);
    // This happens automatically in render(), but we do it early so that
    // the slots appear in the shadow DOM and the elements get attached,
    // allowing us to dispatch events on them.
    this.annotationRenderer.domElement.appendChild(hotspot.element);
  }

  removeHotspot(hotspot: Hotspot) {
    this.target.remove(hotspot);
  }

  /**
   * Helper method to apply a function to all hotspots.
   */
  forHotspots(func: (hotspot: Hotspot) => void) {
    const {children} = this.target;
    for (let i = 0, l = children.length; i < l; i++) {
      const hotspot = children[i];
      if (hotspot instanceof Hotspot) {
        func(hotspot);
      }
    }
  }

  /**
   * Update the CSS visibility of the hotspots based on whether their normals
   * point toward the camera.
   */
  updateHotspots(viewerPosition: Vector3) {
    this.forHotspots((hotspot) => {
      view.copy(viewerPosition);
      target.setFromMatrixPosition(hotspot.matrixWorld);
      view.sub(target);
      normalWorld.copy(hotspot.normal)
          .transformDirection(this.target.matrixWorld);
      if (view.dot(normalWorld) < 0) {
        hotspot.hide();
      } else {
        hotspot.show();
      }
    });
  }

  /**
   * Rotate all hotspots to an absolute orientation given by the input number of
   * radians. Zero returns them to upright.
   */
  orientHotspots(radians: number) {
    this.forHotspots((hotspot) => {
      hotspot.orient(radians);
    });
  }

  /**
   * Set the rendering visibility of all hotspots. This is used to hide them
   * during transitions and such.
   */
  setHotspotsVisibility(visible: boolean) {
    this.forHotspots((hotspot) => {
      hotspot.visible = visible;
    });
  }
}
