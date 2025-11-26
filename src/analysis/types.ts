export interface MethodLocation {
    name: string;
    class_name: string;
    file_path: string;
    line: number;
    column: number;
    end_line: number;
    end_column: number;
    is_async?: boolean;
    is_abstract?: boolean;
    decorators?: string[];
}

export interface MethodRelationship {
    method: MethodLocation;
    base_methods: MethodLocation[];
    override_methods: MethodLocation[];
}

export interface ClassInheritance {
    full_name: string;
    base_classes: string[];
    sub_classes: string[];
    line?: number;  // Class definition line number
}

export interface FileInheritanceData {
    methods?: MethodRelationship[];
    classes?: { [className: string]: ClassInheritance };
}

export interface InheritanceIndex {
    [filePath: string]: MethodRelationship[] | FileInheritanceData;
}

export interface MethodKey {
    filePath: string;
    className: string;
    methodName: string;
    line: number;
}

