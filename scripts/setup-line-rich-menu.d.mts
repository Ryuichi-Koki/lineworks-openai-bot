export type RichMenuArea = {
  bounds: { x: number; y: number; width: number; height: number };
  action: {
    type: string;
    label: string;
    data?: string;
    displayText?: string;
    text?: string;
  };
};

export type RichMenuDefinition = {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
};

export declare const richMenuDefinition: RichMenuDefinition;
