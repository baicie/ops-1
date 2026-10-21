package dev.opsweave.hello;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;

@SpringBootApplication
public class HelloApplication {
    public static final java.util.concurrent.atomic.AtomicBoolean READY = new java.util.concurrent.atomic.AtomicBoolean(false);

    public static void main(String[] args) {
        SpringApplication.run(HelloApplication.class, args);
    }

    @EventListener(ApplicationReadyEvent.class)
    public void ready() {
        READY.set(true);
        System.out.println("INFO hello-java runtime ready version=" + RuntimeState.version());
    }

    @jakarta.annotation.PreDestroy
    public void stopping() {
        READY.set(false);
        System.out.println("INFO hello-java readiness disabled for graceful shutdown");
    }
}
