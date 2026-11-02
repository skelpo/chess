import { Histogram } from "./repro-perry-shape-clones.ts";

const histogram = new Histogram();
for (let i = 0; i < 1000; i++) histogram.add(i);
console.log(histogram.score());
console.log(histogram.text());
