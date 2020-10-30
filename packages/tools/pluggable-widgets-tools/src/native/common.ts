import { ImageStyle, TextStyle, ViewStyle } from "react-native";

interface CustomStyle {
    [key: string]: string | number;
}

export interface Style {
    [key: string]: CustomStyle | ViewStyle | TextStyle | ImageStyle | object;
}

export function mergeNativeStyles<T extends Style>(defaultStyle: T, overrideStyles: Array<T | undefined>): T {
    const styles = [defaultStyle, ...overrideStyles.filter((object): object is T => object !== undefined)];

    return Object.keys(defaultStyle).reduce((flattened, currentKey) => {
        const styleItems = styles.map(object => object[currentKey]);
        return {
            ...flattened,
            [currentKey]: flattenObjects(styleItems)
        };
    }, {} as T);
}

function flattenObjects<T extends object>(objects: T[]): T {
    return objects.reduce((merged, object) => ({ ...merged, ...object }), {} as T);
}

export function extractStyles<TObj extends {}, TKeys extends Array<keyof TObj>>(
    source: TObj | undefined,
    extractionKeys: TKeys
): [Pick<TObj, typeof extractionKeys[number]>, Omit<TObj, typeof extractionKeys[number]>] {
    if (!source) {
        return [{}, {}] as any;
    }

    return Object.entries(source).reduce<[Record<string, unknown>, Record<string, unknown>]>(
        ([extracted, rest]: [any, any], [key, value]: [string, any]) => {
            if (extractionKeys.includes(key as keyof TObj)) {
                extracted[key] = value;
            } else {
                rest[key] = value;
            }
            return [extracted, rest];
        },
        [{}, {}]
    ) as any;
}
