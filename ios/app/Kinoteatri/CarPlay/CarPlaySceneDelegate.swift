// The car's screen (CarPlay): a template scene, declared in Info.plist (project.yml) as
// "CarPlaySceneDelegate". It shares AppModel with the phone, so a play started in the car is the
// phone's play too. What the car can show, and why there's no picture on it: ios/CARPLAY.md.

import CarPlay
import UIKit

@objc(CarPlaySceneDelegate)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var controller: CarPlayController?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        let controller = CarPlayController(interface: interfaceController, app: AppModel.shared)
        self.controller = controller
        AppModel.shared.carPlay(connected: true)
        controller.connect()
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        controller?.disconnect()
        controller = nil
        AppModel.shared.carPlay(connected: false)
    }
}
