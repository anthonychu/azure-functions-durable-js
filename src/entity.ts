import * as debug from "debug";
import { DurableEntityBindingInfo, DurableEntityContext, EntityId, EntityState, IEntityFunctionContext,
    OperationResult, RequestMessage, Signal, Utils } from "./classes";

/** @hidden */
const log = debug("orchestrator");

/** @hidden */
export class Entity {
    constructor(public fn: (context: IEntityFunctionContext) => unknown) { }

    public listen() {
        return this.handle.bind(this);
    }

    private async handle(context: IEntityFunctionContext): Promise<void> {
        const entityBinding = Utils.getInstancesOf<DurableEntityBindingInfo>(
            context.bindings, new DurableEntityBindingInfo(new EntityId("samplename", "samplekey"), true, "", []))[0];

        if (entityBinding === undefined) {
            throw new Error("Could not find an entityTrigger binding on context.");
        }

        // Setup
        const returnState: EntityState = new EntityState([], []);
        returnState.entityExists = entityBinding.exists;
        returnState.entityState = entityBinding.state;
        for (let i = 0; i < entityBinding.batch.length; i++) {
            const startTime = new Date();
            context.df = this.getCurrentDurableEntityContext(entityBinding, returnState, i, startTime);

            try {
                this.fn(context);
                if (!returnState.results[i]) {
                    const elapsedMs = this.computeElapsedMilliseconds(startTime);
                    returnState.results[i] = new OperationResult(false, elapsedMs);
                }
            } catch (error) {
                const elapsedMs = this.computeElapsedMilliseconds(startTime);
                returnState.results[i] = new OperationResult(true, elapsedMs, JSON.stringify(error));
            }
        }

        context.done(null, returnState);
    }

    private getCurrentDurableEntityContext(bindingInfo: DurableEntityBindingInfo, batchState: EntityState, requestIndex: number, startTime: Date): DurableEntityContext  {
        const currentRequest = bindingInfo.batch[requestIndex];
        return {
            entityName: bindingInfo.self.name,
            entityKey: bindingInfo.self.key,
            entityId: bindingInfo.self,
            operationName: currentRequest.name,
            isNewlyConstructed: !batchState.entityExists,
            getState: this.getState.bind(this, batchState),
            setState: this.setState.bind(this, batchState),
            getInput: this.getInput.bind(this, currentRequest),
            return: this.return.bind(this, batchState, startTime),
            destructOnExit: this.destructOnExit.bind(this, batchState),
            signalEntity: this.signalEntity.bind(this, batchState),
            dispatch: this.dispatch.bind(this, currentRequest, batchState, startTime),
        };
    }

    private destructOnExit(batchState: EntityState): void {
        batchState.entityExists = false;
        batchState.entityState = undefined;
    }

    private getInput(currentRequest: RequestMessage): unknown | undefined {
        if (currentRequest.input) {
            return JSON.parse(currentRequest.input);
        }
        return undefined;
    }

    private getState(returnState: EntityState, initializer?: () => unknown): unknown | undefined {
        if (returnState.entityState) {
            return JSON.parse(returnState.entityState);
        } else if (initializer != null) {
            return initializer();
        }
        return undefined;
    }

    private return(returnState: EntityState, startTime: Date, result: unknown): void {
        returnState.entityExists = true;
        returnState.results.push(new OperationResult(false, this.computeElapsedMilliseconds(startTime), JSON.stringify(result)));
    }

    private setState(returnState: EntityState, state: unknown): void {
        returnState.entityExists = true;
        returnState.entityState = JSON.stringify(state);
    }

    // private signalEntity(returnState: EntityState, entity: EntityId, operationName: string, operationInput?: unknown): void {
    //     returnState.signals.push(new Signal(entity, operationName, operationInput ? JSON.stringify(operationInput) : ""));
    // }
    private signalEntity<T>(returnState: EntityState, entityId: EntityId, arg2: string | T, arg3?: any): void {
        let operationName: string;
        let operationInput: string;
        if (typeof(arg2) === "string") {
            operationName = arg2;
            operationInput = arg3 ? JSON.stringify(arg3) : "";
        } else {
            const entityObject = arg2;
            const action: (entityObject: T) => unknown = arg3;
            const proxy = createEntityProxy<T>(entityObject);
            const signalParameters: any = action(proxy);
            operationName = signalParameters.operationName;
            operationInput = signalParameters.operationContent;
        }
        returnState.signals.push(new Signal(entityId, operationName, operationInput ? JSON.stringify(operationInput) : ""));

        function createEntityProxy<U>(entityObject: any): U {
            let obj = entityObject;
            const props = [];
            do {
                props.push(...Object.getOwnPropertyNames(obj));
                obj = Object.getPrototypeOf(obj);
            } while (obj);

            props.forEach((p) => {
                if (typeof(entityObject[p]) === "function") {
                    entityObject[p] = (...args: any[]) => {
                        return {
                            operationName: p,
                            operationContent: args,
                        };
                    };
                }
            });
            return entityObject;
        }
    }

    private computeElapsedMilliseconds(startTime: Date): number {
        const endTime = new Date();
        return endTime.getTime() - startTime.getTime();
    }

    private async dispatch<T>(currentRequest: RequestMessage, returnState: EntityState, startTime: Date, entityFactory: () => T) {
        const operationName = currentRequest.name;
        if (!operationName) {
            throw new Error("Undefined operation");
        }

        const state = this.getState(returnState, () => ({}));
        const entity: any = Object.assign(entityFactory(), state);

        if (typeof(entity[operationName]) !== "function") {
            throw new Error(`Method "${operationName}" does not exist in entity`);
        }

        const input: any[] = this.getInput(currentRequest) as any[];
        let result: any = entity[operationName](...input);

        const isPromise = result && typeof(result.then) === "function";
        if (isPromise) {
            result = await result;
        }

        this.setState(returnState, entity);
        this.return(returnState, startTime, result);
    }
}
