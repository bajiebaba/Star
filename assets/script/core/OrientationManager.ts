import { _decorator, Camera, Component, screen, view } from 'cc';

const { ccclass, property } = _decorator;

/**
 * 横竖屏视口适配：根据宽高比调整正交相机 orthoHeight。
 */
@ccclass('OrientationManager')
export class OrientationManager extends Component {
    @property(Camera)
    camera: Camera | null = null;

    @property({ tooltip: '横屏基准 orthoHeight' })
    baseOrthoHeight = 667;

    @property({ tooltip: '竖屏视口相对缩放' })
    portraitScale = 1.08;

    private _lastAspect = 0;

    onLoad(): void {
        if (!this.camera) {
            this.camera = this.getComponentInChildren(Camera);
        }
        view.setResizeCallback(this._onResize.bind(this));
        screen.on('window-resize', this._onResize, this);
        this._apply();
    }

    onDestroy(): void {
        screen.off('window-resize', this._onResize, this);
    }

    private _onResize(): void {
        this._apply();
    }

    private _apply(): void {
        if (!this.camera) {
            return;
        }

        const size = view.getVisibleSize();
        const aspect = size.width / size.height;
        if (Math.abs(aspect - this._lastAspect) < 0.001) {
            return;
        }
        this._lastAspect = aspect;

        // 竖屏略放大视口，保证上下滚轴不憋屈
        if (aspect < 1) {
            this.camera.orthoHeight = this.baseOrthoHeight * this.portraitScale;
        } else {
            this.camera.orthoHeight = this.baseOrthoHeight;
        }
    }
}
