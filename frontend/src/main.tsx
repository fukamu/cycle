import { mountApplication } from "./app/mountApplication";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("root element is missing");
}

mountApplication(root);
