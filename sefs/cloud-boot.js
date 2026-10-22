import { mountSefsCloud } from "./cloud-kit.js";

window.SEFSCloud = { mount: mountSefsCloud };
window.dispatchEvent(new Event("sefs-cloud-ready"));
